import { describe, expect, it } from 'vitest'

import { VariableFlags } from '../../src/core/console/index.ts'
import { Session } from '../../src/core/engine/index.ts'
import { createProcess, join, runCommand, type TestProcess } from './helpers.ts'

async function serverWithSession(): Promise<{ server: TestProcess; session: Session }> {
  const server = await createProcess()
  return { server, session: new Session(server.manager) }
}

/** The value of a variable of a process, and whether it is replicated and modified. */
function variable(proc: TestProcess, name: string): [string, boolean, boolean] | undefined {
  const { variables } = proc.manager.console
  const found = variables.find(name)
  if (found === undefined) return undefined
  const flags = variables.flagsOf(name)
  return [
    found.value,
    (flags & VariableFlags.replicated) !== 0,
    (flags & VariableFlags.modified) !== 0,
  ]
}

describe('Replicated variables', () => {
  it('reach clients as they join, and as they change, once a tick of the server', async () => {
    const { server, session } = await serverWithSession()
    runCommand(server.manager, 'setr sv_one 1', 'system.console')
    runCommand(server.manager, 'set sv_two 2', 'system.console')
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    expect([variable(client, 'sv_one'), variable(client, 'sv_two')]).toEqual([
      ['1', true, true],
      undefined,
    ])
    // The ticks that let the client join marked the variable of the server as sent.
    expect(variable(server, 'sv_one')).toEqual(['1', true, false])
    runCommand(server.manager, 'setr sv_one 2', 'system.console')
    runCommand(server.manager, 'setr sv_three 3', 'system.console')
    runCommand(server.manager, 'set sv_four 4', 'system.console')
    expect(variable(client, 'sv_one')![0]).toBe('1')
    server.manager.tick()
    // Clients keep what their server sends marked modified.
    client.manager.tick()
    expect([
      variable(client, 'sv_one'),
      variable(client, 'sv_three'),
      variable(server, 'sv_three'),
      variable(client, 'sv_four'),
    ]).toEqual([['2', true, true], ['3', true, true], ['3', true, false], undefined])
  })

  it('reach clients in the order of the bytes of their names', async () => {
    const { server, session } = await serverWithSession()
    // Names match whatever the case of their letters, which the bytes of D and B order before c and a.
    for (const line of ['setr sv_c 1', 'setr sv_D 2']) {
      runCommand(server.manager, line, 'system.console')
    }
    const client = await createProcess({ side: 'client' })
    const changed: string[] = []
    client.manager.console.variables.watch((name) => changed.push(name))
    join(session, client.manager)
    for (const line of ['setr sv_a 3', 'setr sv_B 4']) {
      runCommand(server.manager, line, 'system.console')
    }
    server.manager.tick()
    expect(changed).toEqual(['sv_D', 'sv_c', 'sv_B', 'sv_a'])
  })

  it('reach no client that has not joined', async () => {
    const { server, session } = await serverWithSession()
    const client = await createProcess({ side: 'client' })
    session.connect(client.manager)
    runCommand(server.manager, 'setr sv_one 1', 'system.console')
    server.manager.tick()
    expect(variable(client, 'sv_one')).toBeUndefined()
    server.manager.tick()
    expect(variable(client, 'sv_one')).toEqual(['1', true, true])
  })

  it('leave the user preferences of clients as they are, which they say in developer mode', async () => {
    const { server, session } = await serverWithSession()
    runCommand(server.manager, 'setr ui_mine theirs', 'system.console')
    const client = await createProcess({ side: 'client' })
    const { manager } = client
    manager.console.variables.define('ui_mine', VariableFlags.userPref, 'string', 'mine')
    runCommand(manager, 'developer 1', 'system.console')
    client.take()
    join(session, manager)
    expect([variable(client, 'ui_mine'), client.take()]).toEqual([
      ['mine', false, false],
      ['[net] Blocked convar ui_mine from being set by server.'],
    ])
  })

  it('go from clients that leave their server, which take back what they had', async () => {
    const { server, session } = await serverWithSession()
    for (const line of [
      'setr cl_own theirs',
      'setr sv_new new',
      'setr sv_enableNetEventReassembly false',
    ]) {
      runCommand(server.manager, line, 'system.console')
    }
    const client = await createProcess({ side: 'client' })
    const { manager } = client
    runCommand(manager, 'set cl_own mine', 'system.console')
    const player = join(session, manager)
    // The server sends variables again as they change, which the client keeps what it had before of.
    for (const line of ['setr cl_own again', 'setr sv_new newer']) {
      runCommand(server.manager, line, 'system.console')
    }
    server.manager.tick()
    expect([
      variable(client, 'cl_own'),
      variable(client, 'sv_new'),
      variable(client, 'sv_enableNetEventReassembly'),
    ]).toEqual([
      ['again', true, true],
      ['newer', true, true],
      ['false', true, true],
    ])
    player.quit()
    manager.tick()
    expect([
      variable(client, 'cl_own'),
      variable(client, 'sv_new'),
      variable(client, 'sv_enableNetEventReassembly'),
    ]).toEqual([['mine', false, true], undefined, ['true', true, false]])
    // What the client has of its own once it left stays as it leaves the next server.
    runCommand(manager, 'set sv_new mine', 'system.console')
    const other = await serverWithSession()
    join(other.session, manager).quit()
    manager.tick()
    expect(variable(client, 'sv_new')).toEqual(['mine', false, true])
  })
})
