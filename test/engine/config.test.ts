import { describe, expect, it } from 'vitest'

import { MemoryFileSystem, type FileSystem } from '../../src/core/engine/index.ts'
import { createProcess, runCommand, type TestProcess } from './helpers.ts'

/** A server whose files are `files`, by their paths. */
async function serverWith(files: Record<string, string>): Promise<TestProcess> {
  return createProcess({ files: new MemoryFileSystem(files) })
}

/** Runs a command line as the console of the process, and returns what it printed. */
function run(proc: TestProcess, line: string, principal = 'system.console'): string[] {
  runCommand(proc.manager, line, principal)
  return proc.take()
}

function valueOf(proc: TestProcess, name: string): string | undefined {
  return proc.manager.console.variables.find(name)?.value
}

/** A resource whose server script prints its name as it starts. */
function printing(name: string): Record<string, string> {
  return {
    [`resources/${name}/fxmanifest.lua`]: `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'`,
    [`resources/${name}/main.lua`]: `print('${name}')`,
  }
}

describe('exec', () => {
  it('runs the commands of config files, the last one without a line break too', async () => {
    const proc = await serverWith({
      'server.cfg': 'set a 1\nset b "x y"\r\n# set nothing\nset c 3',
    })
    expect(run(proc, 'exec server.cfg')).toEqual([])
    expect([valueOf(proc, 'a'), valueOf(proc, 'b'), valueOf(proc, 'c')]).toEqual(['1', 'x y', '3'])
    expect(valueOf(proc, 'nothing')).toBe(undefined)
  })

  it('says which config files there are none of', async () => {
    const proc = await serverWith({ 'server.cfg': '' })
    expect(run(proc, 'exec missing.cfg')).toEqual(['[cmd] No such config file: missing.cfg'])
    expect(run(proc, 'exec "a\0b"')).toEqual(['[cmd] No such config file: a'])
    expect(run(proc, 'exec')).toEqual(['[cmd] Argument count mismatch (passed 0, wanted 1)'])
  })

  it('runs config files that config files exec where they exec them', async () => {
    const proc = await serverWith({
      ...printing('a'),
      ...printing('b'),
      ...printing('c'),
      'server.cfg': 'ensure a\nexec cfg/other.cfg\nensure c',
      'cfg/other.cfg': 'ensure b',
    })
    proc.manager.scanResources()
    proc.take()
    expect(run(proc, 'exec server.cfg').filter((line) => line.startsWith('[script:'))).toEqual([
      '[script:a] a',
      '[script:b] b',
      '[script:c] c',
    ])
  })

  it('runs the commands after a wait at later ticks', async () => {
    const proc = await serverWith({ 'server.cfg': 'set a 1\nwait 100\nset b 2' })
    run(proc, 'exec server.cfg')
    expect([valueOf(proc, 'a'), valueOf(proc, 'b')]).toEqual(['1', undefined])
    // The line break exec adds after the file keeps its last command apart from what follows.
    proc.manager.console.addToBuffer('set c 3')
    proc.tickAt(100)
    expect(valueOf(proc, 'b')).toBe(undefined)
    proc.tickAt(101)
    expect([valueOf(proc, 'b'), valueOf(proc, 'c')]).toEqual(['2', '3'])
  })

  it('opens @name/ in the directory of the resource that scans found by the name', async () => {
    const proc = await serverWith({
      'resources/[cfg]/settings/fxmanifest.lua': `fx_version 'cerulean'`,
      'resources/[cfg]/settings/sub/x.cfg': 'set from resource',
      'resources/[cfg]/settings/b/x.cfg': 'set from b',
    })
    const { manager } = proc
    manager.addResource('own', { files: { 'x.cfg': 'set own yes' }, metadata: [] })
    expect(run(proc, 'exec @settings/sub/x.cfg')).toEqual([
      '[cmd] No such config file: @settings/sub/x.cfg',
    ])
    manager.scanResources()
    proc.take()
    run(proc, 'exec @settings/sub/x.cfg')
    expect(valueOf(proc, 'from')).toBe('resource')
    run(proc, 'set from nothing')
    run(proc, 'exec @settings/../settings/sub/x.cfg')
    expect(valueOf(proc, 'from')).toBe('resource')
    expect(run(proc, 'exec @Settings/sub/x.cfg')).toEqual([
      '[cmd] No such config file: @Settings/sub/x.cfg',
    ])
    expect(run(proc, 'exec @settingsb/x.cfg')).toEqual([
      '[cmd] No such config file: @settingsb/x.cfg',
    ])
    // FiveM mounts only the resources that its scans find.
    expect(run(proc, 'exec @own/x.cfg')).toEqual(['[cmd] No such config file: @own/x.cfg'])
    expect(run(proc, 'exec resources/own/x.cfg')).toEqual([])
    expect(valueOf(proc, 'own')).toBe('yes')
  })

  it('opens @name/ where scans last found the resource, and nowhere once it no longer loads', async () => {
    let files = new MemoryFileSystem({
      'resources/a/fxmanifest.lua': `fx_version 'cerulean'`,
      'resources/a/x.cfg': 'set at first',
    })
    // Directories the scans do not see, whose files are there all the same.
    let hidden = new Set<string>()
    const swappable: FileSystem = {
      list: (path) => files.list(path)?.filter(({ name }) => !hidden.has(`${path}/${name}`)),
      read: (path) => files.read(path),
      size: (path) => files.size(path),
      readAt: (path, offset, length) => files.readAt(path, offset, length),
      write: (path, data) => files.write(path, data),
      makeDirectory: (path) => files.makeDirectory(path),
      remove: (path) => files.remove(path),
      rename: (from, to) => files.rename(from, to),
      writeAt: (path, offset, data) => files.writeAt(path, offset, data),
      resize: (path, length) => files.resize(path, length),
    }
    const proc = await createProcess({ files: swappable })
    proc.manager.scanResources()
    files = new MemoryFileSystem({
      'resources/[moved]/a/fxmanifest.lua': `fx_version 'cerulean'`,
      'resources/[moved]/a/x.cfg': 'set at moved',
    })
    proc.manager.scanResources()
    proc.take()
    run(proc, 'exec @a/x.cfg')
    expect(valueOf(proc, 'at')).toBe('moved')
    files = new MemoryFileSystem({
      'resources/[moved]/a/x.cfg': 'set at moved',
      'resources/[again]/a/x.cfg': 'set at again',
    })
    hidden = new Set(['resources/[moved]'])
    proc.manager.scanResources()
    proc.take()
    expect(run(proc, 'exec @a/x.cfg')).toEqual(['[cmd] No such config file: @a/x.cfg'])
  })

  it('runs config files as the code that runs exec', async () => {
    const proc = await serverWith({ 'x.cfg': 'set a 1' })
    proc.manager.security.addEntry('resource.r', 'command.exec', 'allow')
    expect(run(proc, 'exec x.cfg', 'resource.r')).toEqual(['[cmd] Access denied for command set.'])
    expect(valueOf(proc, 'a')).toBe(undefined)
  })

  it('belongs to servers', async () => {
    const proc = await createProcess({ side: 'client' })
    expect(run(proc, 'exec x.cfg')).toEqual(['[cmd] No such command exec.'])
  })
})
