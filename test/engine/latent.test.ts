import { describe, expect, it } from 'vitest'

import { Session } from '../../src/core/engine/index.ts'
import { LATENT_LIMIT } from '../../src/core/engine/latent.ts'
import { createProcess, join, runCommand, type TestProcess } from './helpers.ts'

/**
 * A server with a session and resource a, whose down command sends clients
 * a latent event with a string of as many bytes as it is given, which they
 * print the length of, as its up command does on clients, for the server.
 */
async function serverWithSession(): Promise<{ server: TestProcess; session: Session }> {
  const server = await createProcess()
  const session = new Session(server.manager)
  server
    .add('a', {
      'fxmanifest.lua': [
        `fx_version 'cerulean'`,
        `game 'gta5'`,
        `client_script 'client.lua'`,
        `server_script 'server.lua'`,
      ].join('\n'),
      'server.lua': `RegisterCommand('down', function(_, args)
  TriggerLatentClientEvent('down', args[1], tonumber(args[2]), string.rep('x', tonumber(args[3])))
end, true)
RegisterNetEvent('up', function(data) print('up', source, #data) end)`,
      'client.lua': `RegisterNetEvent('down', function(data) print('down', source, #data) end)
RegisterCommand('up', function(_, args)
  TriggerLatentServerEvent('up', tonumber(args[1]), string.rep('y', tonumber(args[2])))
end, false)`,
    })
    .start()
  server.take()
  return { server, session }
}

/** A client that joined a session and started the resources of its server. */
async function joined(session: Session): Promise<TestProcess> {
  const client = await createProcess({ side: 'client' })
  join(session, client.manager)
  client.manager.tick()
  client.manager.tick()
  client.take()
  return client
}

/** What the scripts of a process printed since it was last asked. */
function scripts(proc: TestProcess): string[] {
  return proc.take().filter((line) => line.startsWith('[script:'))
}

describe('Latent events', () => {
  it('reach clients from net:0 once their last fragment would have, at the rate given', async () => {
    const { server, session } = await serverWithSession()
    const client = await joined(session)
    // With its name, the event takes three fragments, of a second each at 2047 bytes per second.
    runCommand(server.manager, 'down 1 2047 5000', 'system.console')
    // The first fragment goes at the next tick of the server.
    server.tickAt(100)
    server.tickAt(2099)
    client.manager.tick()
    expect(scripts(client)).toEqual([])
    server.tickAt(2100)
    client.manager.tick()
    expect(scripts(client)).toEqual(['[script:a] down\t0\t5000'])
    // Each target gets the event once.
    server.tickAt(5000)
    client.manager.tick()
    expect(scripts(client)).toEqual([])
  })

  it('reach servers from the net ids of the players of clients, at the rate given', async () => {
    const { server, session } = await serverWithSession()
    const client = await joined(session)
    runCommand(client.manager, 'up 2047 5000', 'system.console')
    client.tickAt(0)
    client.tickAt(1999)
    server.manager.tick()
    expect(scripts(server)).toEqual([])
    client.tickAt(2000)
    server.manager.tick()
    expect(scripts(server)).toEqual(['[script:a] up\t1\t5000'])
  })

  it('go at 25000 bytes per second when they are given no rate', async () => {
    const { server, session } = await serverWithSession()
    const client = await joined(session)
    runCommand(server.manager, 'down 1 0 5000', 'system.console')
    // FiveM keeps the 81.88 milliseconds a fragment takes as 81.
    server.tickAt(0)
    server.tickAt(161)
    client.manager.tick()
    expect(scripts(client)).toEqual([])
    server.tickAt(162)
    client.manager.tick()
    expect(scripts(client)).toEqual(['[script:a] down\t0\t5000'])
  })

  it('go to the players that joined, by the net ids they have, or to all of them for -1', async () => {
    const { server, session } = await serverWithSession()
    const ann = await joined(session)
    const bob = await joined(session)
    const carl = await createProcess({ side: 'client' })
    session.connect(carl.manager)
    // Ann connected with 65536, which no latent event goes to.
    for (const target of ['2', '-1', '65536', '9', ' +2x']) {
      runCommand(server.manager, `down ${target} 0 1`, 'system.console')
    }
    server.manager.tick()
    for (const client of [ann, bob, carl]) client.manager.tick()
    expect([scripts(ann), scripts(bob), scripts(carl)]).toEqual([
      ['[script:a] down\t0\t1'],
      ['[script:a] down\t0\t1', '[script:a] down\t0\t1', '[script:a] down\t0\t1'],
      [],
    ])
  })

  it('reach no player, and no server, that the player left before their last fragment would have', async () => {
    const { server, session } = await serverWithSession()
    const ann = await joined(session)
    const bob = await joined(session)
    runCommand(server.manager, 'down 1 2047 5000', 'system.console')
    runCommand(bob.manager, 'up 2047 5000', 'system.console')
    server.tickAt(0)
    bob.tickAt(0)
    for (const { manager } of [ann, bob]) manager.player!.quit()
    server.tickAt(2000)
    bob.tickAt(2000)
    server.manager.tick()
    ann.manager.tick()
    expect([scripts(ann), scripts(server)]).toEqual([[], []])
  })

  it('go to no player that joins after them', async () => {
    const { server, session } = await serverWithSession()
    const ann = await joined(session)
    const carl = await createProcess({ side: 'client' })
    session.connect(carl.manager)
    runCommand(server.manager, 'down -1 2047 5000', 'system.console')
    // Carl joins at the second tick of the server, and starts its resources at two of his own.
    server.tickAt(0)
    server.tickAt(100)
    carl.manager.tick()
    carl.manager.tick()
    server.tickAt(2000)
    for (const { manager } of [ann, carl]) manager.tick()
    expect([scripts(ann), scripts(carl)]).toEqual([['[script:a] down\t0\t5000'], []])
  })

  it('are turned on by sv_enableNetEventReassembly, which clients take from their server', async () => {
    const server = await createProcess()
    const client = await createProcess({ side: 'client' })
    for (const { manager } of [server, client]) {
      runCommand(manager, 'sv_enableNetEventReassembly', 'system.console')
    }
    runCommand(client.manager, 'set sv_enableNetEventReassembly false', 'system.console')
    expect([server.take(), client.take(), client.manager.reassembling]).toEqual([
      [
        '[cmd]  "sv_enableNetEventReassembly" is "true"',
        '[cmd]  default: "true" - flags( )',
        '[cmd]  type: bool',
      ],
      [
        '[cmd]  "sv_enableNetEventReassembly" is "true"',
        '[cmd]  default: "true" - flags( Replicated )',
        '[cmd]  type: bool',
        '[cmd] Cannot set server-replicated ConVar sv_enableNetEventReassembly from client console.',
      ],
      true,
    ])
  })

  it('wait while sv_enableNetEventReassembly is off, and are not sent then', async () => {
    const { server, session } = await serverWithSession()
    const client = await joined(session)
    runCommand(server.manager, 'down 1 0 5000', 'system.console')
    server.tickAt(0)
    runCommand(server.manager, 'set sv_enableNetEventReassembly false', 'system.console')
    runCommand(server.manager, 'down 1 0 1', 'system.console')
    server.tickAt(500)
    client.manager.tick()
    expect(scripts(client)).toEqual([])
    runCommand(server.manager, 'set sv_enableNetEventReassembly true', 'system.console')
    server.tickAt(500)
    client.manager.tick()
    expect(scripts(client)).toEqual(['[script:a] down\t0\t5000'])
    // Clients take the variable from their server, as code of their own may set it.
    const { manager } = client
    const variable = manager.console.variables.find('sv_enableNetEventReassembly')!
    manager.security.runAs('system.internal', () => variable.set('false'))
    runCommand(manager, 'up 0 1', 'system.console')
    expect([server.warnings, client.warnings]).toEqual([
      [
        'a: [natives] TRIGGER_LATENT_CLIENT_EVENT_INTERNAL requires setr sv_enableNetEventReassembly true\n',
      ],
      [
        'a: [natives] TRIGGER_LATENT_SERVER_EVENT_INTERNAL requires setr sv_enableNetEventReassembly true\n',
      ],
    ])
  })

  it('fail for targets that std::stoi reads no int from', async () => {
    const server = await createProcess()
    server
      .add('b', {
        'main.lua': `print(pcall(TriggerLatentClientEvent, 'x', 'abc', 0))
print(pcall(TriggerLatentClientEvent, 'x', '99999999999', 0))`,
      })
      .start()
    expect(server.take().filter((line) => line.startsWith('[script:'))).toEqual([
      '[script:b] false\tnative 0000000070b35890: invalid stoi argument',
      '[script:b] false\tnative 0000000070b35890: stoi argument out of range',
    ])
  })

  it('go from clients to no server while they are not connected to one, nor without a name', async () => {
    const client = await createProcess({ side: 'client' })
    client
      .add(
        'c',
        {
          'main.lua': `TriggerLatentServerEventInternal(nil, '', 0, 0)
TriggerLatentServerEvent('up', 0, 'z')`,
        },
        [
          ['fx_version', 'cerulean'],
          ['client_script', 'main.lua'],
        ],
      )
      .start()
    client.manager.tick()
    expect(client.diagnostics).toEqual([
      'c: TriggerLatentServerEventInternal was given no event name: FiveM would read it from nowhere, and crash. FiveLab sends nothing.',
      "c: TriggerLatentServerEvent sent up to no server, as FiveLab's client is not connected to one.",
    ])
  })

  it('say so of events too large to send, and warn about large ones at almost any rate, every 5 seconds', async () => {
    const proc = await createProcess()
    const { latent } = proc.manager
    const delivered: string[] = []
    const to = (name: string) => [() => delivered.push(name)]
    // With its name and the length of that, an event of 3 bytes is too large from 5 bytes under the limit.
    const huge = new Uint8Array(LATENT_LIMIT - 5)
    latent.send('big', huge, 2147483647, to('too large'))
    latent.send('big', huge.subarray(1), 2147483647, to('largest'))
    const large = huge.subarray(0, 50_000_000)
    latent.send('fast', large, 10_000_000, [])
    proc.time = 4999
    latent.send('fast', large, 10_000_000, [])
    proc.time = 5000
    latent.send('fast', large, 10_000_000, [])
    proc.time = 10000
    latent.send('fast', huge.subarray(0, 49_999_999), 99_999_999, [])
    latent.send('fast', large, 9_999_999, [])
    proc.manager.tick()
    const warning = (name: string, size: number, rate: number) =>
      `[citizen-resources-core] Warning: sending large event ${name} (${size} bytes) with almost unrestricted bitrate (${rate} b/s). This may cause performance issues. Consider decreasing objects sizes or bitrate.`
    // The largest event that may go is large too, and the first fast one comes too soon after it.
    expect([proc.take(), delivered]).toEqual([
      [
        `[citizen-resources-core] Event big is too large to be sent. Total size: ${LATENT_LIMIT}, max size: ${LATENT_LIMIT}.`,
        warning('big', LATENT_LIMIT - 6, 2147483647),
        warning('fast', 50_000_000, 10_000_000),
      ],
      ['largest'],
    ])
  })
})
