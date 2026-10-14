import { describe, expect, it } from 'vitest'

import { Session, type PlayerIdentity } from '../../src/core/engine/index.ts'
import { createProcess, join, runCommand, type TestProcess } from './helpers.ts'

/**
 * A server with a session and resource a, which runs `script` on the
 * server and has clients print, as JSON, what the server says that their
 * commands printed.
 */
async function serverWith(script: string): Promise<{ server: TestProcess; session: Session }> {
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
      'client.lua': `RegisterNetEvent('__cfx_internal:serverPrint', function(text) print(json.encode(text)) end)`,
      'server.lua': script,
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

/** Runs commands on clients, then ticks their server, which runs them, and the clients, which hear what they printed. */
function send(server: TestProcess, commands: readonly [TestProcess, string][]): void {
  for (const [client, line] of commands) runCommand(client.manager, line, 'system.console')
  server.manager.tick()
  for (const [client] of commands) client.manager.tick()
}

describe('Commands of clients', () => {
  it('go to the server they joined, which runs them at its next tick and tells them what they printed', async () => {
    const { server, session } = await serverWith(`RegisterCommand('who', function(source, args, raw)
  print(source, #args, raw)
end, false)`)
    const client = await joined(session)
    runCommand(client.manager, 'who a "b c"', 'system.console')
    client.manager.tick()
    expect(client.take()).toEqual([])
    server.manager.tick()
    // FiveM's servers keep what the commands of clients print from their console.
    expect(server.take()).toEqual([])
    client.manager.tick()
    expect(client.take()).toEqual(['[script:a] "1\\t2\\twho a \\"b c\\"\\n"'])
  })

  it('run as the principals of their players, and say so when these may not run them', async () => {
    const { server, session } = await serverWith(
      `RegisterCommand('vip', function(source) print('vip', source) end, true)`,
    )
    runCommand(server.manager, 'add_ace identifier.license:a command.vip allow', 'system.console')
    const ann = await joined(session, { identifiers: ['license:a'] })
    const bob = await joined(session)
    send(server, [
      [ann, 'vip'],
      [bob, 'vip'],
    ])
    expect([ann.take(), bob.take()]).toEqual([
      ['[script:a] "vip\\t1\\n"'],
      ['[script:a] "Access denied for command vip.\\n"'],
    ])
  })

  it('go to scripts as __cfx_internal:commandFallback when the server has none of them, which may take them', async () => {
    const { server, session } =
      await serverWith(`AddEventHandler('__cfx_internal:commandFallback', function(raw)
  print('fallback', type(source), source, raw)
  if raw == 'add_ace a b allow' then CancelEvent() end
end)
AddEventHandler('rconCommand', function(name) print('rcon', name) end)`)
    runCommand(server.manager, 'add_ace player.2 command.allowed allow', 'system.console')
    const ann = await joined(session)
    const bob = await joined(session)
    // The server has add_ace in its default console, after its own, which clients have not.
    send(server, [
      [ann, 'add_ace a b allow'],
      [bob, 'allowed "x y"'],
      [ann, 'add_ace c d allow'],
    ])
    // What a player may run goes to rconCommand first, and nothing says that the server has no such command.
    expect([ann.take(), bob.take()]).toEqual([
      [
        '[script:a] "fallback\\tnumber\\t1\\tadd_ace a b allow\\n"',
        '[script:a] "fallback\\tnumber\\t1\\tadd_ace c d allow\\nAccess denied for command add_ace.\\n"',
      ],
      ['[script:a] "rcon\\tallowed\\nfallback\\tnumber\\t2\\tallowed \\"x y\\"\\n"'],
    ])
    // Commands of the console go to no __cfx_internal:commandFallback, and those for others get no line once clients' ran.
    server.take()
    runCommand(server.manager, 'stray', 'system.console')
    runCommand(server.manager, 'stray', undefined, '9')
    expect(server.take()).toEqual([
      '[script:a] rcon\tstray',
      '[cmd] No such command stray.',
      '[script:a] fallback\tnumber\t9\t',
    ])
  })

  it('go to scripts at the orders FiveM gives them among the callbacks of onFallback', async () => {
    const { server, session } = await serverWith(
      `AddEventHandler('__cfx_internal:commandFallback', function() print('fallback') end)`,
    )
    const client = await joined(session)
    for (const { manager } of [server, client]) {
      for (const order of [99998, 100000]) {
        manager.console.commands.onFallback.connect((name) => {
          manager.log('test', `${order} ${name}\n`)
        }, order)
      }
    }
    send(server, [[client, 'x']])
    // The client sends the command before its last callback, which then never sees it.
    expect(client.take()).toEqual([
      '[test] 99998 x',
      '[script:a] "99998 x\\nfallback\\n100000 x\\n"',
    ])
  })

  it('run on clients that have not joined a server, which have none of them', async () => {
    const { server, session } = await serverWith('')
    const client = await createProcess({ side: 'client' })
    const run = () => {
      runCommand(client.manager, 'who', 'system.console')
      return client.take().filter((line) => line.startsWith('[cmd]'))
    }
    expect(run()).toEqual(['[cmd] No such command who.'])
    session.connect(client.manager)
    expect(run()).toEqual(['[cmd] No such command who.'])
    server.manager.tick()
    server.manager.tick()
    client.manager.player!.quit()
    expect(run()).toEqual(['[cmd] No such command who.'])
  })

  it('print on the consoles of servers that do not keep them from it, on forward:<net id>/<channel>', async () => {
    const { server, session } = await serverWith(
      `RegisterCommand('hi', function() print('hi') end, false)`,
    )
    runCommand(server.manager, 'con_removeChannelFilter forward:*/* noprint', 'system.console')
    const client = await joined(session)
    server.take()
    send(server, [[client, 'hi']])
    expect(server.take()).toEqual(['[forward:1/script:a] hi'])
  })

  it('tell clients nothing when they printed nothing, or when the server dropped their players', async () => {
    const { server, session } = await serverWith(`RegisterCommand('quiet', function() end, false)
RegisterCommand('leave', function(source) print('bye') DropPlayer(source, 'Bye') end, false)`)
    const client = await joined(session)
    send(server, [[client, 'quiet']])
    expect(client.take()).toEqual([])
    send(server, [[client, 'leave']])
    expect(client.take()).toEqual([])
  })
})
