import { describe, expect, it } from 'vitest'

import { Session, type Player, type PlayerIdentity } from '../../src/core/engine/index.ts'
import { Extension, pack, toJson } from '../../src/core/engine/msgpack.ts'
import { createProcess, join, runCommand, type TestProcess } from './helpers.ts'

/** A manifest for clients that runs main.lua, with natives FiveLab has. */
const CLIENT_SCRIPT = [
  ['fx_version', 'cerulean'],
  ['client_script', 'main.lua'],
] as const

/** A server with a session, which runs `code` in resource a. */
async function serverWith(
  code: string,
  oneSync = true,
): Promise<{ server: TestProcess; session: Session }> {
  const server = await createProcess({ oneSync })
  const session = new Session(server.manager)
  server.add('a', { 'main.lua': code }).start()
  server.take()
  return { server, session }
}

async function newClient(): Promise<TestProcess> {
  return createProcess({ side: 'client' })
}

/** A client script that prints the players that join and drop that clients are told of. */
const WATCH = `RegisterNetEvent('onPlayerJoining', function(...) print('joining', ...) end)
RegisterNetEvent('onPlayerDropped', function(...) print('dropped', ...) end)`

/** Starts resource c on the server, which gives clients a script with `code`. */
function clientScript(server: TestProcess, code: string): void {
  server.add('c', { 'main.lua': code }, CLIENT_SCRIPT).start()
  server.take()
}

/** Lets a client join, then ticks it until the resources of the server started on it. */
function ready(session: Session, client: TestProcess, identity: PlayerIdentity = {}): Player {
  const player = join(session, client.manager, identity)
  client.manager.tick()
  client.manager.tick()
  client.take()
  return player
}

/** What the scripts of a process printed since it was last asked. */
function scripts(proc: TestProcess): string[] {
  return proc.take().filter((line) => line.startsWith('[script:'))
}

/** Ticks the server `count` times, and returns the messages of the player's deferrals that each tick left. */
function messages(server: TestProcess, player: Player, count: number): (string | undefined)[] {
  const said: (string | undefined)[] = []
  for (let i = 0; i < count; i++) {
    server.manager.tick()
    if (said.at(-1) !== player.message) said.push(player.message)
  }
  return said
}

describe('Connecting players', () => {
  it('connect with temporary net ids, which playerConnecting and playerJoining name', async () => {
    const { server, session } = await serverWith(`AddEventHandler('playerConnecting', function(name)
    print('connecting', source, name, GetPlayerName(source), DoesPlayerExist(source), #GetPlayers())
end)
AddEventHandler('playerJoining', function(...)
    print('joining', source, ...)
    local old = ...
    print(type(old), GetPlayerName(old), DoesPlayerExist(old), #GetPlayers())
end)`)
    const client = await newClient()
    const player = session.connect(client.manager, { name: 'Ann' })
    expect([player.state, player.netId, player.temporaryNetId, player.connected]).toEqual([
      'connecting',
      65536,
      65536,
      false,
    ])
    expect([client.manager.session, client.manager.player]).toEqual([session, undefined])
    expect(scripts(server)).toEqual([])
    server.manager.tick()
    expect(scripts(server)).toEqual(['[script:a] connecting\t65536\tAnn\tAnn\t1\t0'])
    expect(player.state).toBe('connecting')
    server.manager.tick()
    expect(scripts(server)).toEqual([
      '[script:a] joining\t1\t65536',
      '[script:a] string\tAnn\tfalse\t1',
    ])
    expect([player.state, player.netId, player.connected]).toEqual(['joined', 1, true])
    expect(client.manager.player).toBe(player)
    expect(session.connect((await newClient()).manager).netId).toBe(65537)
  })

  it('are refused when handlers of playerConnecting cancel it, for the reason they set', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(name, setKickReason)
    if name == 'Bob' then
        setKickReason('Banned')
        setKickReason('Banned for good')
    end
    if name ~= 'Eve' then CancelEvent() end
end)`)
    const players = await Promise.all(
      ['Ann', 'Bob', 'Eve'].map(async (name) => {
        const client = await newClient()
        return session.connect(client.manager, { name })
      }),
    )
    server.manager.tick()
    server.manager.tick()
    expect(players.map(({ state, rejection }) => [state, rejection])).toEqual([
      ['rejected', 'Resource prevented connection.'],
      ['rejected', 'Banned for good'],
      ['joined', undefined],
    ])
    expect([session.player(65536), session.player(65537), session.player(1)]).toEqual([
      undefined,
      undefined,
      players[2],
    ])
    expect(players[0]!.client.session).toBe(undefined)
    expect(Array.from(session.players)).toEqual([players[2]])
  })

  it('wait for the deferrals that handlers of playerConnecting make, which say where they are', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(name, setKickReason, deferrals)
    deferrals.defer()
    Wait(0)
    deferrals.update('Checking ' .. name)
    Wait(0)
    if name == 'Bob' then deferrals.done('Not whitelisted') else deferrals.done() end
end)`)
    const ann = session.connect((await newClient()).manager, { name: 'Ann' })
    expect(messages(server, ann, 6)).toEqual(['a: Deferring connection...\n', 'a: Checking Ann\n'])
    expect(ann.state).toBe('joined')
    const bob = session.connect((await newClient()).manager, { name: 'Bob' })
    messages(server, bob, 6)
    expect([bob.state, bob.rejection]).toEqual(['rejected', 'Not whitelisted'])
  })

  it('connect at once when handlers end their deferrals as playerConnecting runs', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    deferrals.update('Checking')
    deferrals.done()
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    expect([player.state, player.message]).toEqual(['connecting', undefined])
    server.manager.tick()
    expect(player.state).toBe('joined')
  })

  it('wait for the deferrals of every resource, ordered by their names, until one refuses', async () => {
    const { server, session } = await serverWith(`local pending
AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    pending = deferrals
end)
AddEventHandler('finish', function(reason)
    if reason then pending.done(reason) else pending.done() end
end)`)
    server
      .add('b', {
        'main.lua': `local pending
AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.update('Looking')
    pending = deferrals
end)
AddEventHandler('finish', function(reason)
    if reason then pending.done(reason) else pending.done() end
end)`,
      })
      .start()
    server.take()
    const finish = (resource: string, ...reason: string[]) =>
      server.manager.events.trigger(
        'finish',
        pack(reason),
        '',
        server.manager.getResource(resource),
      )
    const first = session.connect((await newClient()).manager)
    server.manager.tick()
    // A resource that updates without deferring defers with no description.
    expect(first.message).toBe('a: Deferring connection...\n: Looking\n')
    finish('a')
    expect(first.message).toBe(': Looking\n')
    finish('b')
    server.manager.tick()
    expect(first.state).toBe('joined')
    const second = session.connect((await newClient()).manager)
    server.manager.tick()
    finish('b', 'No room')
    expect([second.state, second.rejection]).toEqual(['rejected', 'No room'])
    // Deferrals that refused do nothing more.
    const message = second.message
    finish('a')
    expect([second.message, Array.from(session.players)]).toEqual([message, [first]])
  })

  it('take reasons and messages of one argument, and cards that convert to JSON', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(name, setKickReason, deferrals)
    if name == 'kick' then
        setKickReason('a', 'b')
        CancelEvent()
    elseif name == 'card' then
        -- Cards defer connections too, even those that do not convert to JSON.
        deferrals.presentCard()
        deferrals.presentCard({ x = 0/0 })
    elseif name == 'update' then
        deferrals.update('one', 'two')
    else
        deferrals.defer()
        deferrals.done('a', 'b')
    end
end)`)
    const [kick, card, update, done] = await Promise.all(
      ['kick', 'card', 'update', 'done'].map(async (name) =>
        session.connect((await newClient()).manager, { name }),
      ),
    )
    server.manager.tick()
    expect(server.take()).toEqual([])
    expect([kick!.state, kick!.rejection]).toEqual(['rejected', 'Resource prevented connection.'])
    expect([card!.state, card!.card, card!.message]).toEqual(['connecting', undefined, undefined])
    expect([update!.state, update!.message]).toEqual(['connecting', undefined])
    server.manager.tick()
    expect([done!.state, card!.state, update!.state]).toEqual([
      'joined',
      'connecting',
      'connecting',
    ])
  })

  it('end the deferrals of players that connect without them', async () => {
    const { server, session } = await serverWith(`local pending
AddEventHandler('playerConnecting', function(_, _, deferrals) pending = deferrals end)
AddEventHandler('playerJoining', function() print('joining', source) end)
AddEventHandler('finish', function() pending.done() end)`)
    const player = join(session, (await newClient()).manager)
    expect(scripts(server)).toEqual(['[script:a] joining\t1'])
    server.manager.events.trigger('finish', pack([]))
    server.manager.tick()
    server.manager.tick()
    expect([player.netId, scripts(server)]).toEqual([1, []])
  })

  it('present no card that deferrals present as playerConnecting runs, if they end then', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    deferrals.presentCard('{}')
    deferrals.done()
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    server.manager.tick()
    expect([player.state, player.card]).toEqual(['joined', undefined])
  })

  it('take binaries for cards, and refuse with an unknown error for binary reasons', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    print(rawget(deferrals.presentCard, '__cfx_functionReference'), rawget(deferrals.done, '__cfx_functionReference'))
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    const [presentCard, done] = scripts(server)[0]!.slice('[script:a] '.length).split('\t')
    const { manager } = server
    const call = (ref: string, arg: Uint8Array) =>
      manager.getResource('a')!.enter(() => manager.invokeFunctionReference(ref, pack([arg])))
    // Calls from no resource do nothing.
    manager.invokeFunctionReference(done!, pack([]))
    expect(player.state).toBe('connecting')
    call(presentCard!, new TextEncoder().encode('{"bin":1}'))
    expect(player.card).toBe('{"bin":1}')
    call(done!, new TextEncoder().encode('no'))
    expect([player.state, player.rejection]).toEqual(['rejected', 'Unknown error'])
  })

  it('are refused for an unknown error when deferrals end with a reason that is no string', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(name, _, deferrals)
    deferrals.defer()
    if name == 'nil' then deferrals.done(nil) else deferrals.done(123) end
end)`)
    const players = [
      session.connect((await newClient()).manager, { name: 'nil' }),
      session.connect((await newClient()).manager, { name: '123' }),
    ]
    server.manager.tick()
    expect(players.map(({ rejection }) => rejection)).toEqual(['Unknown error', 'Unknown error'])
  })

  it('hand players over with the data of handover, and present cards as their JSON', async () => {
    const { server, session } = await serverWith(`local pending
AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    deferrals.handover({ b = { c = true }, a = 1 })
    deferrals.handover('no map')
    deferrals.handover({ a = 2.5, d = 0/0 })
    deferrals.presentCard({ type = 'AdaptiveCard', body = { 'x' } })
    pending = deferrals
end)
AddEventHandler('card', function(card) pending.presentCard(card) end)
AddEventHandler('finish', function()
    pending.done()
    pending.presentCard('{"late":true}')
    pending.update('late')
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    expect(player.card).toBe('{"body":["x"],"type":"AdaptiveCard"}')
    const trigger = (event: string, ...args: string[]) =>
      server.manager.events.trigger(event, pack(args))
    trigger('card', '{"raw":true}')
    expect(player.card).toBe('{"raw":true}')
    trigger('finish')
    expect([player.card, player.message]).toEqual(['{"raw":true}', 'a: Deferring connection...\n'])
    expect(Object.fromEntries(player.handover)).toEqual({ a: '2.5', b: '{"c":true}' })
    expect([...player.handover.keys()]).toEqual(['a', 'b'])
  })

  it('give the function of the last card presented with one what clients submit, at the next tick of the server', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    deferrals.presentCard('{}', function(_, raw) print('first', raw) end)
    deferrals.presentCard('{}', function(data, raw)
        print('card', data.n, math.type(data.n), data.f, math.type(data.f), data.s, data.a, raw)
    end)
    deferrals.presentCard('{}')
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    const json = '{"n": 1, "f": 1.0, "s": "x", "a": 1, "a": 2}'
    player.submitCard(json)
    expect(scripts(server)).toEqual([])
    server.manager.tick()
    // FiveM keeps the first of the members of a name.
    expect(scripts(server)).toEqual([`[script:a] card\t1\tinteger\t1.0\tfloat\tx\t1\t${json}`])
    // JSON that RapidJSON fails to read reaches no function.
    player.submitCard('{"n": }')
    server.manager.tick()
    expect(scripts(server)).toEqual([])
  })

  it('give the functions of FiveM for cards what clients submit, as those of scripts', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    deferrals.presentCard('{}', deferrals.done)
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    // done, given what the card gives and its JSON, ends the deferral, which lets the player join.
    player.submitCard('{}')
    server.manager.tick()
    server.manager.tick()
    expect(player.state).toBe('joined')
  })

  it('keep the functions for cards that come as references of FiveLab, as holders of them', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    print(rawget(deferrals.presentCard, '__cfx_functionReference'))
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    const presentCard = scripts(server)[0]!.slice('[script:a] '.length)
    const { manager } = server
    const got: string[] = []
    const callback = (name: string) =>
      manager.callbacks.create((args) => got.push(`${name} ${toJson(args)}`))
    const [first, second] = [callback('first'), callback('second')]
    const present = (card: Extension) =>
      manager
        .getResource('a')!
        .enter(() => manager.invokeFunctionReference(presentCard, pack(['{}', card])))
    // Nothing gets what comes before a card with a function.
    player.submitCard('0')
    present(first)
    present(second)
    present(second)
    player.submitCard('[1]')
    manager.tick()
    // The deferral let go of first as second took its place, and holds second once more than it let go of it.
    const firstRef = new TextDecoder().decode(first.data)
    expect([got, manager.invokeFunctionReference(firstRef, pack([]))]).toEqual([
      ['second [[1],"[1]"]'],
      null,
    ])
  })

  it('let go of the function for cards as the deferrals end, after which nothing gets what clients submit', async () => {
    const { server, session } = await serverWith(`local pending = {}
AddEventHandler('playerConnecting', function(name, _, deferrals)
    deferrals.defer()
    pending[name] = deferrals
    deferrals.presentCard('{}', function(_, raw) print('card', raw) end)
end)
AddEventHandler('finish', function(name, reason)
    if reason then pending[name].done(reason) else pending[name].done() end
end)`)
    const players = await Promise.all(
      ['Ann', 'Bob', 'Carl'].map(async (name) =>
        session.connect((await newClient()).manager, { name }),
      ),
    )
    server.manager.tick()
    for (const player of players) player.submitCard('1')
    // Ann may join, Bob may not, and Carl quits.
    server.manager.events.trigger('finish', pack(['Ann']))
    server.manager.events.trigger('finish', pack(['Bob', 'No']))
    players[2]!.quit()
    for (const player of players) player.submitCard('2')
    server.manager.tick()
    expect(
      server.take().filter((line) => line.includes('ref call') || line.startsWith('[script:')),
    ).toEqual([0, 1, 2].map((ref) => `[script:a] Invalid ref call attempt: ${ref}`))
  })

  it('say when scripts give the functions of connections what FiveM fails to convert', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, setKickReason, deferrals)
    setKickReason({})
    deferrals.update(123)
    deferrals.presentCard({ [1] = 'a', b = 'c' })
    CancelEvent()
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    expect(player.rejection).toBe('Resource prevented connection.')
    expect(server.diagnostics).toEqual([
      'a: setKickReason was given an array, which msgpack fails to convert to a string: msgpack throws then, which FiveLab does not emulate, and it ignores the call.',
      'a: deferrals.update was given an integer, which msgpack fails to convert to a string: msgpack throws then, which FiveLab does not emulate, and it ignores the call.',
      'a: deferrals.presentCard was given a card with a map whose keys are not all of the type of its first, which FiveM fails to convert to JSON: msgpack throws then, which FiveLab does not emulate, and it ignores the call.',
    ])
  })

  it('cannot be dropped, and go when they quit, without playerDropped', async () => {
    const { server, session } = await serverWith(`local pending
AddEventHandler('playerConnecting', function(_, _, deferrals)
    print('dropped', DropPlayer(source, 'no'))
    deferrals.defer()
    pending = deferrals
end)
AddEventHandler('playerDropped', function() print('playerDropped') end)
AddEventHandler('finish', function() pending.done() end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    expect(scripts(server)).toEqual(['[script:a] dropped\tfalse'])
    player.quit()
    server.manager.events.trigger('finish', pack([]))
    server.manager.tick()
    expect([player.state, session.player(65536)]).toEqual(['dropped', undefined])
    expect(scripts(server)).toEqual([])
  })

  it('replace the player with their GUID, which reconnects', async () => {
    const { server, session } = await serverWith(`AddEventHandler('playerDropped', function(...)
    print('dropped', source, ...)
end)`)
    const first = join(session, (await newClient()).manager, { guid: 'g' })
    const second = session.connect((await newClient()).manager, { guid: 'g' })
    expect(scripts(server)).toEqual([
      '[script:a] dropped\t1\tReconnecting\t__cfx_internal:server\t4',
    ])
    expect([first.state, second.state]).toEqual(['dropped', 'connecting'])
  })

  it('may access as player.<their temporary net id> while they connect', async () => {
    const { server, session } = await serverWith(`AddEventHandler('playerConnecting', function()
    print(IsPlayerAceAllowed(source, 'thing'))
end)`)
    runCommand(server.manager, 'add_ace player.65536 thing allow', 'system.console')
    session.connect((await newClient()).manager)
    server.manager.tick()
    expect(scripts(server)).toEqual(['[script:a] 1'])
  })
})

describe('The steps of connections', () => {
  it('are skipped for players that quit before them', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function() print('connecting') end)
AddEventHandler('playerJoining', function() print('joining') end)`)
    session.connect((await newClient()).manager).quit()
    server.manager.tick()
    expect(scripts(server)).toEqual([])
    const second = session.connect((await newClient()).manager)
    server.manager.tick()
    second.quit()
    server.manager.tick()
    expect([scripts(server), second.netId, second.state]).toEqual([
      ['[script:a] connecting'],
      65537,
      'dropped',
    ])
  })

  it('let players join whose deferrals ended as playerConnecting ran, even when canceled', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    deferrals.done()
    CancelEvent()
end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    server.manager.tick()
    expect([player.state, player.rejection]).toEqual(['joined', undefined])
  })

  it('end the deferrals of players that handlers refuse', async () => {
    const { server, session } = await serverWith(`local pending
AddEventHandler('playerConnecting', function(_, _, deferrals)
    deferrals.defer()
    pending = deferrals
    CancelEvent()
end)
AddEventHandler('late', function() pending.update('late') end)`)
    const player = session.connect((await newClient()).manager)
    server.manager.tick()
    // FiveM tells the client where its deferrals are before it refuses it.
    expect([player.state, player.message]).toEqual(['rejected', 'a: Deferring connection...\n'])
    server.manager.events.trigger('late', pack([]))
    expect(player.message).toBe('a: Deferring connection...\n')
  })

  it('tell only clients that joined of who joins and drops without OneSync, but of no one that drops as it joins', async () => {
    const { server, session } = await serverWith(
      `AddEventHandler('playerConnecting', function(name, _, deferrals)
    if name == 'Waiter' then deferrals.defer() end
end)
AddEventHandler('playerJoining', function()
    if GetPlayerName(source) == 'Leaver' then DropPlayer(source, 'bye') end
end)`,
      false,
    )
    clientScript(server, WATCH)
    const ann = await newClient()
    ready(session, ann, { name: 'Ann' })
    const waiter = await newClient()
    waiter.add('c', { 'main.lua': WATCH }, CLIENT_SCRIPT).start()
    waiter.take()
    session.connect(waiter.manager, { name: 'Waiter' })
    join(session, (await newClient()).manager, { name: 'Leaver' })
    join(session, (await newClient()).manager, { name: 'Bob' })
    session.tick()
    expect([scripts(ann), scripts(waiter)]).toEqual([
      ['[script:c] dropped\t2\tLeaver\t-1', '[script:c] joining\t3\tBob\t-1'],
      [],
    ])
  })
})

describe('Joined players', () => {
  it('get events by the temporary net ids they had, which servers warn about once', async () => {
    const { server, session } = await serverWith(`RegisterCommand('send', function(_, args)
    TriggerClientEvent('hello', args[1], args[1])
end, false)`)
    const hello = `RegisterNetEvent('hello', function(...) print('hello', ...) end)`
    clientScript(server, hello)
    const client = await newClient()
    ready(session, client)
    const connecting = await newClient()
    connecting.add('c', { 'main.lua': hello }, CLIENT_SCRIPT).start()
    connecting.take()
    session.connect(connecting.manager)
    for (const target of ['1', '65536', '65536', '65537', '-1']) {
      runCommand(server.manager, `send ${target}`, 'system.console')
    }
    session.tick()
    // Players that connect have no connection for events yet.
    expect([scripts(client), scripts(connecting)]).toEqual([
      [
        '[script:c] hello\t1',
        '[script:c] hello\t65536',
        '[script:c] hello\t65536',
        '[script:c] hello\t-1',
      ],
      [],
    ])
    expect(server.warnings).toEqual([
      'a: [natives] TRIGGER_CLIENT_EVENT_INTERNAL: client 1 is not the same as the target 65536. This happens when the oldId from the playerJoining event is used. Use source instead.\n',
    ])
  })

  it('are told who joins after them without OneSync, but miss what comes before their resources start', async () => {
    for (const oneSync of [true, false]) {
      const { server, session } = await serverWith('', oneSync)
      clientScript(server, WATCH)
      const [first, second] = [await newClient(), await newClient()]
      ready(session, first, { name: 'Ann' })
      ready(session, second, { name: 'Bob' })
      session.tick()
      expect([scripts(first), scripts(second)]).toEqual(
        oneSync ? [[], []] : [['[script:c] joining\t2\tBob\t-1'], []],
      )
    }
  })
})
