import { describe, expect, it } from 'vitest'

import { ChannelAction } from '../../src/core/console/index.ts'
import type { ResourceManager } from '../../src/core/engine/index.ts'
import { createProcess } from './helpers.ts'

/** Runs a command line in the process's console as the console. */
function run(manager: ResourceManager, line: string): void {
  manager.security.runAs('system.console', () => manager.console.execute(line))
}

describe('The consoles of processes', () => {
  it("give servers the entries of FiveM's server, and a console that falls back on the default one", async () => {
    const { manager, take } = await createProcess()
    run(manager, 'list_aces')
    expect(take()).toEqual(
      [
        'system.console -> command = ALLOW',
        'system.console -> command = ALLOW',
        'builtin.everyone -> command.help = ALLOW',
        'resource.monitor -> command.quit = ALLOW',
        'system.console -> webadmin = ALLOW',
      ].map((line) => `[security] ${line}`),
    )
    expect(manager.console).not.toBe(manager.defaultConsole)
    expect(manager.console.fallback).toBe(manager.defaultConsole)
    expect(manager.console.server).toBe(true)
    expect(manager.printer.filters).toEqual([
      { pattern: 'forward:*/*', action: ChannelAction.noPrint },
    ])
    manager.log('forward:a/b', 'hidden\n')
    expect(take()).toEqual([])
  })

  it('let servers restrict who reads console variables, from the default console', async () => {
    const server = await createProcess()
    expect(server.manager.defaultConsole.commands.has('add_convar_permission')).toBe(true)
    run(server.manager, 'add_convar_permission a read secret')
    expect(server.manager.convarPermissions?.mayRead('secret', 'b')).toBe(false)
    const client = await createProcess({ side: 'client' })
    expect(client.manager.defaultConsole.commands.has('add_convar_permission')).toBe(false)
    expect(client.manager.convarPermissions).toBeUndefined()
  })

  it("give clients the entry of FiveM's client, and the default console", async () => {
    const { manager, take } = await createProcess({ side: 'client' })
    run(manager, 'list_aces')
    expect(take()).toEqual([
      '[security] system.internal -> builtin = ALLOW',
      '[security] system.console -> command = ALLOW',
    ])
    expect(manager.console).toBe(manager.defaultConsole)
    expect(manager.console.server).toBe(false)
    expect(manager.printer.filters).toEqual([])
  })

  it('run the commands of the buffer as the console each tick, before resources', async () => {
    const proc = await createProcess()
    proc.add('a', { 'main.lua': `CreateThread(function() print('thread') end)` }).start()
    proc.take()
    const { console } = proc.manager
    console.commands.register('mark', 'test', () => {
      proc.manager.log('cmd', 'command\n')
      return true
    })
    console.addToBuffer('mark\nwait 10\nmark\n')
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[cmd] command', '[script:a] thread'])
    proc.tickAt(10)
    expect(proc.take()).toEqual([])
    proc.tickAt(11)
    expect(proc.take()).toEqual(['[cmd] command'])
  })

  it('print what scripts print as the console prints it', async () => {
    const proc = await createProcess()
    proc.add('a', { 'main.lua': `print('a\\0b')` }).start()
    run(proc.manager, 'con_addChannelFilter script:b drop')
    proc.add('b', { 'main.lua': `print('hidden')` }).start()
    proc.manager.logWarning('cmd', 'careful\n')
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] a^5<\\0>^7b',
      '[resources] Started resource a',
      '[citizen-scripting-core] Creating script environments for b',
      '[resources] Started resource b',
      '[cmd] ^3Warning: careful^7',
    ])
  })
})
