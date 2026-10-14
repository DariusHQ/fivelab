import { describe, expect, it } from 'vitest'

import { netIdAfter, SERVER_NET_ID, Session } from '../../src/core/engine/index.ts'
import { createProcess, runCommand, type TestProcess } from './helpers.ts'

/** A server with a session, and `count` clients connected to it. */
async function sessionWith(count: number): Promise<{
  server: TestProcess
  clients: TestProcess[]
  session: Session
}> {
  const server = await createProcess()
  const session = new Session(server.manager)
  const clients: TestProcess[] = []
  for (let i = 0; i < count; i++) {
    const client = await createProcess({ side: 'client' })
    session.connect(client.manager)
    clients.push(client)
  }
  // The server lets them connect at its next tick, and gives them their net ids at the one after.
  server.manager.tick()
  server.manager.tick()
  return { server, clients, session }
}

/** A manifest for clients that runs main.lua, with natives FiveLab has. */
const CLIENT_SCRIPT = [
  ['fx_version', 'cerulean'],
  ['client_script', 'main.lua'],
] as const

/** What the scripts of a process printed since it was last asked. */
function scripts(proc: TestProcess): string[] {
  return proc.take().filter((line) => line.startsWith('[script:'))
}

describe('Sessions', () => {
  it('connect clients to their server with net ids from 1', async () => {
    const { server, clients, session } = await sessionWith(2)
    const [first, second] = clients.map(({ manager }) => manager)
    expect([first!.player!.netId, second!.player!.netId]).toEqual([1, 2])
    expect(Array.from(session.players, (player) => player.client)).toEqual([first, second])
    expect(session.player(2)).toBe(second!.player)
    expect(session.player(3)).toBe(undefined)
    expect(first!.player!.session).toBe(session)
    expect([server.manager.session, first!.session]).toEqual([session, session])
    expect(server.manager.player).toBe(undefined)
  })

  it('count net ids as FiveM does, from 1 to 65534', () => {
    expect([netIdAfter(1), netIdAfter(65533), netIdAfter(65534)]).toEqual([2, 65534, 1])
    expect(SERVER_NET_ID).toBe(65535)
  })

  it('take one server, and clients that are not connected yet', async () => {
    const { server, clients, session } = await sessionWith(1)
    const client = clients[0]!.manager
    const other = await createProcess()
    expect(() => new Session(client)).toThrow(new Error('A session needs a server'))
    expect(() => new Session(server.manager)).toThrow(new Error('The server has a session already'))
    expect(() => session.connect(other.manager)).toThrow(
      new Error('Only clients connect to servers'),
    )
    expect(() => session.connect(client)).toThrow(new Error('The client is connected already'))
  })

  it('tick the server, then the clients', async () => {
    const { server, clients, session } = await sessionWith(2)
    const order: string[] = []
    for (const [name, proc] of [
      ['server', server],
      ['first', clients[0]!],
      ['second', clients[1]!],
    ] as const) {
      proc.manager.console.commands.add('mark', [], () => order.push(name))
      proc.manager.console.addToBuffer('mark\n')
    }
    session.tick()
    expect(order).toEqual(['server', 'first', 'second'])
  })
})

describe('Net events', () => {
  it('go from clients to the server for its next tick, from net:<their net id>', async () => {
    const { server, clients, session } = await sessionWith(2)
    server
      .add('a', {
        'main.lua': `RegisterNetEvent('ping', function(...)
    print('ping', source, ...)
end)
AddEventHandler('unsafe', function() print('unsafe') end)`,
      })
      .start()
    server.take()
    clients[1]!
      .add('b', {
        'main.lua': `TriggerServerEvent('ping', 1, 'x')
TriggerServerEvent('unsafe')`,
      })
      .start()
    expect(scripts(server)).toEqual([])
    session.tick()
    expect(server.take()).toEqual([
      '[script:a] ping\t2\t1\tx',
      '[script:a] event unsafe was not safe for net',
    ])
  })

  it('go from the server to a client or to all of them, from net:65535', async () => {
    const { server, clients, session } = await sessionWith(2)
    for (const client of clients) {
      client
        .add('c', {
          'main.lua': `RegisterNetEvent('hello', function(...)
    print('hello', source, ...)
end)`,
        })
        .start()
      client.take()
    }
    server
      .add('a', {
        'main.lua': `TriggerClientEvent('hello', -1, 'all')
TriggerClientEvent('hello', 2, 'two')
TriggerClientEvent('hello', '2nd', 'as atoi reads it')
TriggerClientEvent('hello', 3, 'nobody')`,
      })
      .start()
    expect(server.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[resources] Started resource a',
    ])
    expect(clients.map(scripts)).toEqual([[], []])
    session.tick()
    expect(clients.map(scripts)).toEqual([
      ['[script:c] hello\t65535\tall'],
      [
        '[script:c] hello\t65535\tall',
        '[script:c] hello\t65535\ttwo',
        '[script:c] hello\t65535\tas atoi reads it',
      ],
    ])
  })

  it('go nowhere from clients that are not connected, which FiveLab says', async () => {
    const client = await createProcess({ side: 'client' })
    client.add('a', { 'main.lua': `TriggerServerEvent('ping')` }, CLIENT_SCRIPT).start()
    expect(client.diagnostics).toEqual([
      "a: TriggerServerEvent sent ping to no server, as FiveLab's client is not connected to one.",
    ])
  })

  it('have no payload for a null pointer, of which FiveM reads more than nothing', async () => {
    const server = await createProcess()
    server
      .add('a', {
        'main.lua': `TriggerClientEventInternal('x', '-1', nil, 0)
TriggerClientEventInternal('x', '-1', nil, 3)`,
      })
      .start()
    expect(server.diagnostics).toEqual([
      'a: TriggerClientEventInternal was given no payload, but a length of 3: FiveM would read that many bytes from nowhere, and crash. FiveLab sends no payload.',
    ])
    const client = await createProcess({ side: 'client' })
    client
      .add(
        'b',
        {
          'main.lua': `TriggerServerEventInternal(nil, '', 0)
TriggerServerEventInternal('y', nil, 2)`,
        },
        CLIENT_SCRIPT,
      )
      .start()
    expect(client.diagnostics).toEqual([
      'b: TriggerServerEventInternal was given no event name: FiveM would read it from nowhere, and crash. FiveLab sends nothing.',
      'b: TriggerServerEventInternal was given no payload, but a length of 2: FiveM would read that many bytes from nowhere, and crash. FiveLab sends no payload.',
      "b: TriggerServerEvent sent y to no server, as FiveLab's client is not connected to one.",
    ])
  })

  it('check the name and the target that servers send events with', async () => {
    const server = await createProcess()
    server
      .add('a', {
        'main.lua': `print(pcall(TriggerClientEventInternal, nil, '-1', '', 0))
print(pcall(TriggerClientEventInternal, 'x', nil, '', 0))`,
      })
      .start()
    expect(scripts(server)).toEqual([
      '[script:a] false\tnative 000000002f7a49e6: Argument at index 0 was null.',
      '[script:a] false\tnative 000000002f7a49e6: Argument at index 1 was null.',
    ])
  })

  it('warn about large events that servers send, every five seconds', async () => {
    const server = await createProcess()
    server
      .add('a', {
        'main.lua': `RegisterCommand('send', function(_, args)
    TriggerClientEvent('big', -1, string.rep('x', tonumber(args[1])))
end, false)`,
      })
      .start()
    server.take()
    // A payload of one string takes 6 bytes more than the string.
    const send = (size: number, time: number) => {
      server.time = time
      runCommand(server.manager, `send ${size - 6}`, 'system.console')
      return server.take()
    }
    const warning = (size: number) => [
      `[citizen-server-impl] Warning: sending large event big (${size} bytes). This may cause performance issues. Consider using latent events instead.`,
    ]
    expect(send(999_999, 0)).toEqual([])
    expect(send(1_000_000, 0)).toEqual(warning(1_000_000))
    expect(send(1_000_001, 4999)).toEqual([])
    expect(send(1_000_002, 5000)).toEqual(warning(1_000_002))
  })
})
