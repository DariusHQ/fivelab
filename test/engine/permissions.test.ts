import { describe, expect, it } from 'vitest'

import { createProcess, runCommand, type TestProcess } from './helpers.ts'

/** Runs a command line as the console of the process, and returns what it printed. */
function run(proc: TestProcess, line: string): string[] {
  runCommand(proc.manager, line, 'system.console')
  return proc.take()
}

/** Starts a resource that writes x.txt in other as it starts, and returns whether it could. */
function writes(proc: TestProcess, name: string): string {
  proc.add(name, { 'main.lua': `print(SaveResourceFile('other', 'x.txt', 'x', -1))` }).start()
  const printed = proc.take().filter((line) => line.startsWith(`[script:${name}]`))
  return printed.map((line) => line.slice(`[script:${name}] `.length)).join()
}

describe('add_filesystem_permission', () => {
  it('lets resources write the files of others, until read takes it back', async () => {
    const proc = await createProcess()
    proc.add('other', {}, [])
    expect(run(proc, 'add_filesystem_permission a write other')).toEqual([])
    run(proc, 'add_filesystem_permission c write other')
    run(proc, 'add_filesystem_permission c read other')
    run(proc, 'add_filesystem_permission d delete other')
    run(proc, 'add_filesystem_permission E write other')
    run(proc, 'add_filesystem_permission f write Other')
    run(proc, 'add_filesystem_permission g write other')
    run(proc, 'add_filesystem_permission g delete other')
    expect(writes(proc, 'a')).toBe('1')
    expect(proc.manager.files.read('resources/other/x.txt')).toEqual(new Uint8Array([120]))
    expect(writes(proc, 'b')).toBe('false')
    expect(writes(proc, 'c')).toBe('false')
    expect(writes(proc, 'd')).toBe('false')
    expect(writes(proc, 'e')).toBe('false')
    expect(writes(proc, 'f')).toBe('false')
    // Operations other than read and write change nothing.
    expect(writes(proc, 'g')).toBe('1')
    expect(proc.diagnostics).toEqual(
      ['b', 'c', 'd', 'e', 'f'].map(
        (name) =>
          `${name}: SaveResourceFile cannot write x.txt in other: FiveM lets resources write the files of others only with add_filesystem_permission.`,
      ),
    )
  })

  it('gives nothing once the server ended its initial configuration, and warns about it', async () => {
    const proc = await createProcess()
    proc.add('other', {}, [])
    proc.manager.endInitialConfiguration()
    expect(run(proc, 'add_filesystem_permission a write other')).toEqual([
      '[citizen-scripting-core] ^3Warning: add_filesystem_permission is only executable before the server finished execution.^7',
    ])
    expect(writes(proc, 'a')).toBe('false')
  })

  it('takes three arguments, on the default console of servers', async () => {
    const proc = await createProcess()
    expect(run(proc, 'add_filesystem_permission a write')).toEqual([
      '[cmd] Argument count mismatch (passed 2, wanted 3)',
    ])
    expect(proc.manager.defaultConsole.commands.has('add_filesystem_permission')).toBe(true)
    expect(proc.manager.console.commands.has('add_filesystem_permission')).toBe(false)
    const client = await createProcess({ side: 'client' })
    expect(run(client, 'add_filesystem_permission a write b')).toEqual([
      '[cmd] No such command add_filesystem_permission.',
    ])
  })
})

describe('The permissions for JavaScript', () => {
  it('are taken until the server ended its initial configuration, and warn after', async () => {
    const proc = await createProcess()
    for (const command of ['add_unsafe_worker_permission', 'add_unsafe_child_process_permission']) {
      expect(run(proc, `${command} a`)).toEqual([])
      expect(run(proc, command)).toEqual(['[cmd] Argument count mismatch (passed 0, wanted 1)'])
    }
    proc.manager.endInitialConfiguration()
    for (const command of ['add_unsafe_worker_permission', 'add_unsafe_child_process_permission']) {
      expect(run(proc, `${command} a`)).toEqual([
        `[citizen-scripting-core] ^3Warning: ${command} is only executable before the server finished execution.^7`,
      ])
    }
  })
})
