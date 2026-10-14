import { describe, expect, it } from 'vitest'

import { freeSlot, Session, StateBags, type PlayerIdentity } from '../../src/core/engine/index.ts'
import { pack } from '../../src/core/engine/msgpack.ts'
import { createProcess, join, runCommand, startResource, type TestProcess } from './helpers.ts'

/** What the scripts of a process printed since it was last asked. */
function scripts(proc: TestProcess): string[] {
  return proc.take().filter((line) => line.startsWith('[script:'))
}

describe('State bags of a process', () => {
  it('keep msgpack values by key, ordered by their bytes, which nil deletes', async () => {
    const server = await createProcess()
    expect(
      startResource(server, 'a', {
        'main.lua': `GlobalState.b = 1
GlobalState.a = { x = 2 }
GlobalState.B = 'c'
print(GlobalState.b, GlobalState.a.x, json.encode(GetStateBagKeys('global')), StateBagHasKey('global', 'b'))
GlobalState.b = nil
GlobalState.none = nil
print(GlobalState.b, StateBagHasKey('global', 'b'), json.encode(GetStateBagKeys('global')))
local value = msgpack.pack(1)
SetStateBagValue('nope', 'k', value, #value, true)
print(GetStateBagValue('nope', 'k'), StateBagHasKey('nope', 'k'), #GetStateBagKeys('nope'))`,
      }),
    ).toEqual([
      // FiveM's BOOL natives give Lua 1 for true.
      '[script:a] 1\t2\t["B","a","b"]\t1',
      '[script:a] nil\tfalse\t["B","a"]',
      '[script:a] nil\tfalse\t0',
    ])
  })

  it('give handlers the changes they filter, before they happen, with their source and whether they replicate', async () => {
    const server = await createProcess()
    expect(
      startResource(server, 'a', {
        'main.lua': `local cookie = AddStateBagChangeHandler('a', '', function(bag, key, value, source, replicated)
    print('a', bag, key, value, source, replicated, GlobalState.a)
end)
local any = AddStateBagChangeHandler('', 'global', function(_, key) print('any', key) end)
AddStateBagChangeHandler(nil, 'other', function() print('other') end)
print('cookies', cookie, any)
GlobalState.a = 1
GlobalState.b = 2
GlobalState.b = 2
GlobalState:set('a', 3, false)
RemoveStateBagChangeHandler(cookie)
RemoveStateBagChangeHandler(99)
GlobalState.a = 4`,
      }),
    ).toEqual([
      '[script:a] cookies\t0\t1',
      '[script:a] a\tglobal\ta\t1\t0\ttrue\tnil',
      '[script:a] any\ta',
      // Handlers get changes that change nothing too.
      '[script:a] any\tb',
      '[script:a] any\tb',
      '[script:a] a\tglobal\ta\t3\t0\tfalse\t1',
      '[script:a] any\ta',
      '[script:a] any\ta',
    ])
  })

  it('keep no value that is no msgpack while handlers would get it', async () => {
    const server = await createProcess()
    expect(
      startResource(server, 'a', {
        'main.lua': `local bad = string.char(0xc1)
SetStateBagValue('global', 'kept', bad, 1, false)
AddStateBagChangeHandler('', '', function(_, key) print('change', key) end)
SetStateBagValue('global', 'dropped', bad, 1, false)
print(StateBagHasKey('global', 'kept'), StateBagHasKey('global', 'dropped'))`,
      }),
    ).toEqual(['[script:a] 1\tfalse'])
  })

  it('take as many bytes of values as scripts say, which may not be more than they give', async () => {
    const server = await createProcess()
    expect(
      startResource(server, 'a', {
        'main.lua': `local value = msgpack.pack('abc')
SetStateBagValue('global', 'none', value, 0, false)
print(StateBagHasKey('global', 'none'), GlobalState.none)
print(pcall(SetStateBagValue, 'global', 'long', value, 99, false))`,
      }).filter((line) => line.startsWith('[script:')),
    ).toEqual([
      '[script:a] 1\tnil',
      '[script:a] false\tnative 000000008d50e33a: arg[2]: buffer length too large (99 > 4)',
    ])
  })

  it('stop handling changes for resources that stop, and let go of their functions', async () => {
    const server = await createProcess()
    const { manager } = server
    startResource(server, 'h', {
      'main.lua': `AddStateBagChangeHandler('', '', function(_, key) print('h', key) end)`,
    })
    startResource(server, 'r', {
      'main.lua': `cookie = AddStateBagChangeHandler('', '', function(_, key) print('r', key) end)
RegisterCommand('remove', function() RemoveStateBagChangeHandler(cookie) end, true)`,
    })
    const ref = `r:${manager.getResource('r')!.runtime!.host.instanceId}:0`
    manager.getResource('h')!.stop()
    runCommand(manager, 'remove', 'system.console')
    server.take()
    // With no handler left, the bags keep values that are no msgpack.
    const started = startResource(server, 's', {
      'main.lua': `GlobalState.x = 1
SetStateBagValue('global', 'bad', string.char(0xc1), 1, false)
print(StateBagHasKey('global', 'bad'))`,
    })
    manager.invokeFunctionReference(ref, pack([]))
    expect([started, server.take()]).toEqual([
      ['[script:s] 1'],
      ['[script:r] Invalid ref call attempt: 0'],
    ])
  })

  it('give handlers with no filter of a key or a bag the changes of any', async () => {
    const server = await createProcess()
    expect(
      startResource(server, 'a', {
        'main.lua': `AddStateBagChangeHandler(nil, 'global', function(_, key) print('key', key) end)
AddStateBagChangeHandler('b', nil, function(bag, key) print('bag', bag, key) end)
GlobalState.a = 1
GlobalState.b = 2`,
      }),
    ).toEqual(['[script:a] key\ta', '[script:a] key\tb', '[script:a] bag\tglobal\tb'])
  })

  it('fail for the names and keys that FiveM checks', async () => {
    const server = await createProcess()
    expect(
      startResource(server, 'a', {
        'main.lua': `print(pcall(GetStateBagValue, nil, 'k'))
print(pcall(SetStateBagValue, 'global', nil, '', 0, false))
print(pcall(StateBagHasKey, 'global', nil))
print(pcall(GetStateBagKeys, nil))`,
      }).filter((line) => line.startsWith('[script:')),
    ).toEqual([
      '[script:a] false\tnative 00000000637f4c75: Argument at index 0 was null.',
      '[script:a] false\tnative 000000008d50e33a: Argument at index 1 was null.',
      '[script:a] false\tnative 000000000012a330: Argument at index 1 was null.',
      '[script:a] false\tnative 0000000078d864c7: Argument at index 0 was null.',
    ])
  })
})

describe('StateBags', () => {
  /** State bags of a server or a client that record what they send, as "peer bag key value". */
  function bags(server = true): { states: StateBags; sent: string[] } {
    const sent: string[] = []
    const states = new StateBags(server, (peer, bag, key, data) => {
      sent.push(`${peer} ${bag} ${key} ${Array.from(data).join(',')}`)
    })
    return { states, sent }
  }
  const one = () => pack(1)

  it('replicate the changes that change something, to the peers that bags route to in order, or to all', () => {
    const { states, sent } = bags()
    states.registerTarget(7)
    states.registerTarget(8)
    const own = states.register('own')
    own.addRoutingTarget(9)
    own.addRoutingTarget(3)
    own.addRoutingTarget(9)
    const all = states.register('all', true)
    for (const bag of [own, all]) bag.set(0, 'k', one(), true)
    own.set(0, 'k', one(), true)
    own.set(0, 'k', pack(2), false)
    own.set(0, 'k', pack(256), true)
    // A value that starts as the one before does is another.
    own.set(0, 'k', new Uint8Array([205, 1]), true)
    own.set(0, 'k', pack([1, 3]), true)
    own.set(0, 'k', pack([1, 2]), true)
    const kept = Array.from(own.get('k')!)
    own.removeRoutingTarget(3)
    states.unregisterTarget(8)
    for (const bag of [own, all]) bag.set(0, 'k', pack(null), true)
    expect(sent).toEqual([
      '3 own k 1',
      '9 own k 1',
      '7 all k 1',
      '8 all k 1',
      '3 own k 205,1,0',
      '9 own k 205,1,0',
      '3 own k 205,1',
      '9 own k 205,1',
      '3 own k 146,1,3',
      '9 own k 146,1,3',
      '3 own k 146,1,2',
      '9 own k 146,1,2',
      '9 own k 192',
      '7 all k 192',
    ])
    expect([kept, own.has('k'), own.keys()]).toEqual([[146, 1, 2], false, []])
  })

  it('send peers that bags come to route to all their keys, unless the bags route elsewhere', () => {
    const { states, sent } = bags()
    const routed = states.register('routed')
    routed.addRoutingTarget(5)
    routed.set(0, 'b', one(), false)
    routed.set(0, 'a', one(), false)
    states.register('everyone').set(0, 'k', one(), false)
    sent.length = 0
    states.registerTarget(5)
    states.registerTarget(6)
    states.registerTarget(6)
    routed.addRoutingTarget(6)
    // A peer that a bag routes to gets nothing more as it is added again.
    routed.addRoutingTarget(5)
    expect(sent).toEqual([
      '5 routed a 1',
      '5 routed b 1',
      '5 everyone k 1',
      '6 everyone k 1',
      '6 routed a 1',
      '6 routed b 1',
    ])
    // A target that goes is routed to by no bag.
    sent.length = 0
    states.unregisterTarget(6)
    routed.set(0, 'c', one(), true)
    expect(sent).toEqual(['5 routed c 1'])
  })

  it('keep copies of the values they set, which handlers may refuse, and send no empty key or value', () => {
    const { states, sent } = bags()
    states.registerTarget(1)
    const bag = states.register('all', true)
    const value = pack(1)
    bag.set(0, 'k', value, false)
    value[0] = 2
    expect(Array.from(bag.get('k')!)).toEqual([1])
    bag.set(0, '', one(), true)
    bag.set(0, 'empty', new Uint8Array(), true)
    states.onChange.connect((_source, _bag, key) => key !== 'refused')
    bag.set(0, 'refused', one(), true)
    expect([sent, bag.keys(), states.register('all') === bag]).toEqual([
      [],
      ['', 'empty', 'k'],
      true,
    ])
  })

  it('take keys from the owners of bags, or from anyone for bags without one, and create bags as prefixes say', () => {
    const { states, sent } = bags(false)
    states.registerTarget(0)
    states.addPreCreatePrefix('player:', true)
    const owned = states.register('owned')
    owned.owner = 4
    const unnamed = states.register('')
    for (const [source, bag, key] of [
      [3, 'owned', 'k'],
      [4, 'owned', 'k'],
      [3, 'player:1', 'k'],
      [3, 'entity:1', 'k'],
      [3, '', 'k'],
      [3, 'player:1', ''],
    ] as const) {
      states.receive(source, bag, key, one())
    }
    states.receive(3, 'player:1', 'none', new Uint8Array())
    // Clients replicate nothing that they take, while the bags they create route to all.
    states.get('player:1')!.set(0, 'mine', one(), true)
    expect([
      owned.keys(),
      states.get('player:1')?.keys(),
      states.get('entity:1'),
      unnamed.keys(),
      sent,
    ]).toEqual([['k'], ['k', 'mine'], undefined, [], ['0 player:1 mine 1']])
  })

  it('replicate on servers what they take', () => {
    const { states, sent } = bags()
    states.registerTarget(2)
    states.register('all', true)
    states.receive(3, 'all', 'k', one())
    expect(sent).toEqual(['2 all k 1'])
  })
})

describe('Slots', () => {
  it('go to players from the highest, but 31', () => {
    expect(freeSlot(() => false)).toBe(2048)
    expect(freeSlot((slot) => slot > 31)).toBe(30)
    expect(freeSlot((slot) => slot !== 31)).toBe(-1)
    expect(freeSlot((slot) => slot !== 0)).toBe(0)
    expect(freeSlot((slot) => slot > 32 || slot === 30)).toBe(32)
  })
})

/** A server with OneSync or without, whose resource a sets and reads state bags, and has clients print the changes they get. */
async function serverWithBags(oneSync = true): Promise<{ server: TestProcess; session: Session }> {
  const server = await createProcess({ oneSync })
  const session = new Session(server.manager)
  server
    .add('a', {
      'fxmanifest.lua': [
        `fx_version 'cerulean'`,
        `game 'gta5'`,
        `client_script 'client.lua'`,
        `server_script 'server.lua'`,
      ].join('\n'),
      'server.lua': `GlobalState.before = 1
AddStateBagChangeHandler('mine', '', function(bag, key, value, source, replicated)
    print('server', bag, key, value, source, replicated)
end)
RegisterCommand('gset', function(_, args) GlobalState[args[1]] = tonumber(args[2]) end, true)
RegisterCommand('pset', function(_, args) Player(tonumber(args[1])).state[args[2]] = tonumber(args[3]) end, true)
RegisterCommand('read', function(_, args) print('read', GetStateBagValue(args[1], args[2])) end, true)
RegisterCommand('names', function(_, args)
    print('names', GetPlayerFromStateBagName(args[1]), GetEntityFromStateBagName(args[1]))
end, true)`,
      'client.lua': `AddStateBagChangeHandler('', '', function(bag, key, value, source, replicated)
    print('change', bag, key, value, source, replicated)
end)
RegisterCommand('read', function(_, args) print('read', GetStateBagValue(args[1], args[2])) end, false)
RegisterCommand('rset', function(_, args)
    local value = msgpack.pack(tonumber(args[3]))
    SetStateBagValue(args[1], args[2], value, #value, true)
end, false)
RegisterCommand('lset', function(_, args)
    local value = msgpack.pack(tonumber(args[3]))
    SetStateBagValue(args[1], args[2], value, #value, false)
end, false)
RegisterCommand('names', function(_, args) print('names', GetPlayerFromStateBagName(args[1])) end, false)`,
    })
    .start()
  server.take()
  return { server, session }
}

/** A client that joined a session and started the resources of its server. */
async function joined(session: Session, identity: PlayerIdentity = {}): Promise<TestProcess> {
  const client = await createProcess({ side: 'client' })
  join(session, client.manager, identity)
  client.manager.tick()
  client.manager.tick()
  client.take()
  return client
}

describe('State bags across a session', () => {
  it('reach the clients that join, and those that joined as they change', async () => {
    const { server, session } = await serverWithBags()
    const ann = await joined(session)
    // The client takes what its server had before its resources start.
    runCommand(ann.manager, 'read global before', 'system.console')
    expect(scripts(ann)).toEqual(['[script:a] read\t1'])
    runCommand(server.manager, 'gset after 2', 'system.console')
    expect(scripts(ann)).toEqual([])
    ann.manager.tick()
    expect(scripts(ann)).toEqual(['[script:a] change\tglobal\tafter\t2\t0\tfalse'])
    const bob = await joined(session)
    runCommand(bob.manager, 'read global after', 'system.console')
    expect(scripts(bob)).toEqual(['[script:a] read\t2'])
  })

  it('of players reach the clients of the players alone, as their slots', async () => {
    const { server, session } = await serverWithBags()
    const ann = await joined(session)
    const bob = await joined(session)
    expect([...session.players].map(({ slot }) => slot)).toEqual([2048, 2047])
    runCommand(server.manager, 'pset 1 hp 100', 'system.console')
    for (const client of [ann, bob]) client.manager.tick()
    expect([scripts(ann), scripts(bob)]).toEqual([
      ['[script:a] change\tplayer:1\thp\t100\t0\tfalse'],
      [],
    ])
  })

  it('of players come from their clients alone, which get them back, and those of servers from no client', async () => {
    const { server, session } = await serverWithBags()
    const ann = await joined(session)
    const bob = await joined(session)
    // Clients take the bags of players as their server sends them.
    runCommand(server.manager, 'pset 1 hp 100', 'system.console')
    runCommand(server.manager, 'pset 2 hp 100', 'system.console')
    for (const client of [ann, bob]) client.manager.tick()
    for (const client of [ann, bob]) client.take()
    runCommand(ann.manager, 'rset player:1 mine 5', 'system.console')
    // Bob's client has no bag of Ann's, which a client of another kind could still send keys of.
    runCommand(bob.manager, 'rset player:1 mine 6', 'system.console')
    session.receiveStateBag([...session.players][1]!, 'player:1', 'mine', pack(8))
    runCommand(ann.manager, 'rset global mine 7', 'system.console')
    expect(scripts(ann)).toEqual([
      '[script:a] change\tplayer:1\tmine\t5\t0\ttrue',
      '[script:a] change\tglobal\tmine\t7\t0\ttrue',
    ])
    bob.take()
    server.manager.tick()
    ann.manager.tick()
    expect([scripts(server), scripts(ann)]).toEqual([
      ['[script:a] server\tplayer:1\tmine\t5\t2048\ttrue'],
      ['[script:a] change\tplayer:1\tmine\t5\t0\tfalse'],
    ])
    runCommand(server.manager, 'read global mine', 'system.console')
    expect(scripts(server)).toEqual(['[script:a] read\tnil'])
  })

  it('come from no client while servers are in strict mode, which clients that know of it say', async () => {
    const { server, session } = await serverWithBags()
    const ann = await joined(session)
    // Clients take the mode from their servers alone.
    runCommand(ann.manager, 'set sv_stateBagStrictMode true', 'system.console')
    expect([ann.take(), ann.manager.strictStateBags]).toEqual([
      ['[cmd] Cannot set server-replicated ConVar sv_stateBagStrictMode from client console.'],
      false,
    ])
    runCommand(server.manager, 'pset 1 hp 100', 'system.console')
    ann.manager.tick()
    runCommand(server.manager, 'set sv_stateBagStrictMode true', 'system.console')
    runCommand(ann.manager, 'rset player:1 mine 5', 'system.console')
    server.manager.tick()
    expect(scripts(server)).toEqual([])
    runCommand(server.manager, 'setr sv_stateBagStrictMode true', 'system.console')
    server.manager.tick()
    ann.take()
    runCommand(ann.manager, 'rset player:1 mine 6', 'system.console')
    // What servers and clients set for themselves alone is no concern of strict mode.
    runCommand(ann.manager, 'lset player:1 own 7', 'system.console')
    runCommand(server.manager, 'gset x 8', 'system.console')
    runCommand(server.manager, 'read global x', 'system.console')
    expect([ann.warnings, server.warnings, scripts(ann), scripts(server)]).toEqual([
      [
        "a: [natives] StateBags can't be modified from the client, because the StateBag strict mode is enabled. Disable it using setr sv_stateBagStrictMode false\n",
      ],
      [],
      ['[script:a] change\tplayer:1\town\t7\t0\tfalse'],
      ['[script:a] read\t8'],
    ])
  })

  it('name the players of clients with no native of servers', async () => {
    const { session } = await serverWithBags()
    const ann = await joined(session)
    runCommand(ann.manager, 'names player:1', 'system.console')
    expect(scripts(ann)).toEqual(['[script:a] names\t0'])
  })

  it('of players go as they leave, with their slots', async () => {
    const { server, session } = await serverWithBags()
    const ann = await joined(session)
    const player = ann.manager.player!
    runCommand(server.manager, 'pset 1 hp 100', 'system.console')
    runCommand(server.manager, 'names player:1', 'system.console')
    runCommand(server.manager, 'names entity:1', 'system.console')
    player.quit()
    runCommand(server.manager, 'read player:1 hp', 'system.console')
    runCommand(server.manager, 'names player:1', 'system.console')
    expect(scripts(server)).toEqual([
      '[script:a] names\t1\t0',
      '[script:a] names\t0\t0',
      '[script:a] read\tnil',
      '[script:a] names\t0\t0',
    ])
    // The client forgets the bags of its server, but for a new global one.
    ann.manager.tick()
    expect([ann.manager.states.get('player:1'), ann.manager.states.get('global')?.keys()]).toEqual([
      undefined,
      [],
    ])
    // A client that gets the slot again gets the bags that route to all, as a new target.
    const bob = await joined(session)
    runCommand(bob.manager, 'read global before', 'system.console')
    expect([player.slot, [...session.players].map(({ slot }) => slot), scripts(bob)]).toEqual([
      2048,
      [2048],
      ['[script:a] read\t1'],
    ])
  })

  it('send copies of what they send, as the network does', async () => {
    const { server, session } = await serverWithBags()
    const ann = await joined(session)
    runCommand(server.manager, 'pset 1 hp 100', 'system.console')
    const value = pack(1)
    server.manager.states.get('global')!.set(0, 'sent', value, true)
    value.set(pack(2))
    ann.manager.tick()
    ann.manager.states.get('player:1')!.set(0, 'mine', value, true)
    value.set(pack(3))
    server.manager.tick()
    ann.take()
    runCommand(ann.manager, 'read global sent', 'system.console')
    expect([scripts(ann), scripts(server)]).toEqual([
      ['[script:a] read\t1'],
      ['[script:a] server\tplayer:1\tmine\t2\t2048\ttrue'],
    ])
  })

  it('stay with clients that leave before they join, which send their servers nothing until they join', async () => {
    const client = await createProcess({ side: 'client' })
    const { session } = await serverWithBags()
    const { states } = client.manager
    states.get('global')!.set(0, 'alone', pack(1), true)
    session.connect(client.manager).quit()
    client.manager.tick()
    expect(states.get('global')?.keys()).toEqual(['alone'])
  })

  it('reach no client of servers without OneSync, which have no bags of players', async () => {
    const { server, session } = await serverWithBags(false)
    const ann = await joined(session)
    runCommand(server.manager, 'pset 1 hp 100', 'system.console')
    runCommand(server.manager, 'gset after 2', 'system.console')
    runCommand(server.manager, 'read player:1 hp', 'system.console')
    ann.manager.tick()
    runCommand(ann.manager, 'read global after', 'system.console')
    expect([scripts(server), scripts(ann), [...session.players].map(({ slot }) => slot)]).toEqual([
      ['[script:a] read\tnil'],
      ['[script:a] read\tnil'],
      [undefined],
    ])
  })
})
