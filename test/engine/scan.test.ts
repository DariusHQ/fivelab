import { describe, expect, it } from 'vitest'

import {
  MemoryFileSystem,
  type FileSystem,
  type ResourceManager,
} from '../../src/core/engine/index.ts'
import { createProcess, runCommand, type TestProcess } from './helpers.ts'

/** An fxmanifest.lua that FiveM's server starts, with `lines` after its version and game. */
function manifest(...lines: string[]): string {
  return [`fx_version 'cerulean'`, `game 'gta5'`, ...lines].join('\n')
}

/** A server whose files are `files`, by their paths. */
async function serverWith(files: Record<string, string>): Promise<TestProcess> {
  return createProcess({ files: new MemoryFileSystem(files) })
}

/** Scans the resources of the process, and returns what it printed. */
function scan(proc: TestProcess): string[] {
  proc.manager.scanResources()
  return proc.take()
}

/** Files that the test can swap for others, as if files changed on disk. */
function swappable(first: FileSystem): { files: FileSystem; swap: (next: FileSystem) => void } {
  let current = first
  return {
    files: {
      list: (path) => current.list(path),
      read: (path) => current.read(path),
      size: (path) => current.size(path),
      readAt: (path, offset, length) => current.readAt(path, offset, length),
      write: (path, data) => current.write(path, data),
      makeDirectory: (path) => current.makeDirectory(path),
      remove: (path) => current.remove(path),
      rename: (from, to) => current.rename(from, to),
      writeAt: (path, offset, data) => current.writeAt(path, offset, data),
      resize: (path, length) => current.resize(path, length),
    },
    swap: (next) => {
      current = next
    },
  }
}

function pathsOf(manager: ResourceManager): string[] {
  return Array.from(manager.resources, (resource) => `${resource.name} ${resource.path}`)
}

describe('Scanning resources', () => {
  it('finds the resources of the resources directory and of its categories', async () => {
    const proc = await serverWith({
      'resources/a/fxmanifest.lua': manifest(),
      'resources/notes.txt': '',
      'resources/[local]/b/fxmanifest.lua': manifest(),
      'resources/[local]/[maps]/c/__resource.lua': '',
      'server.cfg': '',
    })
    const { manager } = proc
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] ^2Found 3 resources.^7',
    ])
    expect(pathsOf(manager)).toEqual([
      'a resources/a',
      'b resources/[local]/b',
      'c resources/[local]/[maps]/c',
    ])
    expect(manager.getResource('c')!.categories).toEqual(['[local]', '[maps]'])
    expect(manager.getResource('b')!.state).toBe('stopped')
    runCommand(manager, 'start [local]', 'system.console')
    expect(proc.take()).toEqual([
      '[resources] Started resource b',
      '[resources] Started resource c',
    ])
  })

  it('looks at the entries of directories in the order that NTFS lists them', async () => {
    // Neither in the order these came nor in that of their bytes.
    const proc = await serverWith({
      'resources/b/fxmanifest.lua': manifest(),
      'resources/_c/fxmanifest.lua': manifest(),
      'resources/[b]/x/fxmanifest.lua': manifest(),
      'resources/[A]/x/fxmanifest.lua': manifest(),
      'resources/A/fxmanifest.lua': manifest(),
    })
    expect(scan(proc)).toContain(
      '[resources:x] ^3Warning: x exists in more than one place (resources/[A]/x is used, the duplicate is resources/[b]/x)^7',
    )
    expect(pathsOf(proc.manager)).toEqual([
      'A resources/A',
      'b resources/b',
      '_c resources/_c',
      'x resources/[A]/x',
    ])
  })

  it('finds nothing without a resources directory', async () => {
    const proc = await serverWith({ 'server.cfg': '' })
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] ^2Found 0 resources.^7',
    ])
  })

  it("leaves out hidden directories, txAdmin's, and those FiveM has among its system resources", async () => {
    const files = {
      'resources/.hidden/fxmanifest.lua': manifest(),
      'resources/[cat]/.git/fxmanifest.lua': manifest(),
      'resources/TxAdmin/fxmanifest.lua': manifest(),
      'resources/[gameplay]/chat/fxmanifest.lua': manifest(),
      'resources/[system]/yarn/fxmanifest.lua': manifest(),
      'resources/[system]/webpack/fxmanifest.lua': manifest(),
      'resources/[.cat]/a/fxmanifest.lua': manifest(),
    }
    const proc = await serverWith(files)
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] ^2Found 1 resources.^7',
    ])
    expect(pathsOf(proc.manager)).toEqual(['a resources/[.cat]/a'])
    expect(proc.diagnostics).toEqual([
      "chat: FiveM's server leaves out resources/[gameplay]/chat: it has its own chat among its system resources, which it takes instead, unless resources_useSystemChat is false. FiveRunner has no system resources.",
      "webpack: FiveM's server leaves out resources/[system]/webpack: it has its own webpack among its system resources, which it takes instead. FiveRunner has no system resources.",
      "yarn: FiveM's server leaves out resources/[system]/yarn: it has its own yarn among its system resources, which it takes instead. FiveRunner has no system resources.",
    ])
    expect(proc.manager.console.variables.find('resources_useSystemChat')?.value).toBe('true')
    const own = await serverWith(files)
    runCommand(own.manager, 'set resources_useSystemChat false', 'system.console')
    scan(own)
    expect(pathsOf(own.manager)).toEqual(['a resources/[.cat]/a', 'chat resources/[gameplay]/chat'])
  })

  it('warns about resources in more than one place, categories with manifests and resources that do not load', async () => {
    const proc = await serverWith({
      'resources/a/fxmanifest.lua': manifest(),
      'resources/[x]/a/fxmanifest.lua': manifest(),
      'resources/[cat]/fxmanifest.lua': manifest(),
      'resources/[old]/__resource.lua': '',
      'resources/[dir]/fxmanifest.lua/x.txt': '',
      'resources/empty/readme.txt': '',
      'resources/broken/fxmanifest.lua': `fx_version = = 'cerulean'`,
    })
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      "[resources:broken] ^1Error: broken failed to load: Could not parse resource metadata file resources/broken/fxmanifest.lua: broken/fxmanifest.lua:1: unexpected symbol near '='^7",
      '[resources:empty] ^3Warning: empty does not have a resource manifest (fxmanifest.lua)^7',
      "[resources:cat] ^3Warning: [cat] is a category, but has a resource manifest (if this is meant to be a resource, don't use [] around the name)^7",
      "[resources:dir] ^3Warning: [dir] is a category, but has a resource manifest (if this is meant to be a resource, don't use [] around the name)^7",
      "[resources:old] ^3Warning: [old] is a category, but has a resource manifest (if this is meant to be a resource, don't use [] around the name)^7",
      // A directory in a category is a resource, whatever its name.
      '[resources:fxmanifest.lua] ^3Warning: fxmanifest.lua does not have a resource manifest (fxmanifest.lua)^7',
      '[resources:a] ^3Warning: a exists in more than one place (resources/a is used, the duplicate is resources/[x]/a)^7',
      '[resources] ^2Found 4 resources.^7',
      '[resources] ^16 warnings and 1 error were encountered.^7',
    ])
    expect(pathsOf(proc.manager)).toEqual(['a resources/a'])
  })

  it('counts what it encountered as FiveM does', async () => {
    const encountered = async (files: Record<string, string>) =>
      (await scan(await serverWith(files))).at(-1)
    const missing = 'resources/missing/readme.txt'
    const broken = 'resources/broken/fxmanifest.lua'
    expect(await encountered({ [missing]: '' })).toBe('[resources] ^31 warning was encountered.^7')
    expect(await encountered({ [missing]: '', 'resources/other/x.txt': '' })).toBe(
      '[resources] ^32 warnings were encountered.^7',
    )
    expect(await encountered({ [broken]: '=' })).toBe('[resources] ^11 error was encountered.^7')
    expect(await encountered({ [broken]: '=', 'resources/broken2/fxmanifest.lua': '=' })).toBe(
      '[resources] ^12 errors were encountered.^7',
    )
    expect(await encountered({ [missing]: '', [broken]: '=' })).toBe(
      '[resources] ^11 warning and 1 error were encountered.^7',
    )
  })

  it('refreshes resources: reads their manifests again, adds new ones and moves those found elsewhere', async () => {
    const before = new MemoryFileSystem({
      'resources/a/fxmanifest.lua': manifest(`server_script 'main.lua'`),
      'resources/a/main.lua': `AddEventHandler('onResourceListRefresh', function(...)
    print('refreshed', select('#', ...), GetResourceMetadata('a', 'description', 0))
end)`,
      'resources/b/fxmanifest.lua': manifest(),
    })
    const { files, swap } = swappable(before)
    const proc = await createProcess({ files })
    const { manager } = proc
    scan(proc)
    const a = manager.getResource('a')!
    const b = manager.getResource('b')!
    a.start()
    b.start()
    proc.take()
    swap(
      new MemoryFileSystem({
        'resources/a/fxmanifest.lua': manifest(`server_script 'main.lua'`, `description 'new'`),
        'resources/a/main.lua': before.read('resources/a/main.lua')!,
        'resources/c/fxmanifest.lua': manifest(),
        'resources/[moved]/b/fxmanifest.lua': manifest(),
      }),
    )
    runCommand(manager, 'developer 1', 'system.console')
    runCommand(manager, 'refresh', 'system.console')
    expect(proc.take()).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] Found new resource c in resources/c',
      '[resources] Stopping resource b',
      '[resources] Found new resource b in resources/[moved]/b',
      '[resources] ^2Found 2 new resources, and refreshed 1/1 resources.^7',
      '[script:a] refreshed\t0\tnew',
    ])
    expect(b.state).toBe('uninitialized')
    expect(manager.getResource('b')).not.toBe(b)
    expect(pathsOf(manager)).toEqual(['a resources/a', 'c resources/c', 'b resources/[moved]/b'])
    expect(manager.getResource('b')!.categories).toEqual(['[moved]'])
    runCommand(manager, 'refresh', 'system.console')
    expect(proc.take()).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] ^2Found 0 new resources, and refreshed 0/3 resources.^7',
      '[script:a] refreshed\t0\tnew',
    ])
  })

  it('reads the manifests of resources it did not find again from where it finds them', async () => {
    const proc = await serverWith({ 'resources/a/fxmanifest.lua': manifest(`description 'found'`) })
    const a = proc.manager.addResource('a', { files: {}, metadata: [], path: 'elsewhere/a' })
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] ^2Found 0 new resources, and refreshed 1/1 resources.^7',
    ])
    expect(proc.manager.getResource('a')).toBe(a)
    expect(a.path).toBe('elsewhere/a')
    expect(a.entries('description')).toEqual(['found'])
  })

  it('keeps what manifests that no longer load added, as FiveM does, and says so', async () => {
    const { files, swap } = swappable(
      new MemoryFileSystem({ 'resources/a/fxmanifest.lua': manifest() }),
    )
    const proc = await createProcess({ files })
    scan(proc)
    swap(
      new MemoryFileSystem({
        'resources/a/fxmanifest.lua': manifest(`description 'kept'`, `error('broken', 0)`),
      }),
    )
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] ^2Found 0 new resources, and refreshed 1/1 resources.^7',
    ])
    const a = proc.manager.getResource('a')!
    expect(a.metadata.map(([key, value]) => `${key} ${value}`)).toEqual([
      'fx_version cerulean',
      'game gta5',
      'description kept',
    ])
    expect(proc.diagnostics).toHaveLength(1)
    expect(proc.diagnostics[0]).toMatch(
      /^a: The manifest of a no longer loads, and FiveM keeps the entries it added before it failed without saying so: Could not execute resource metadata file resources\/a\/fxmanifest\.lua: broken\nstack traceback:\n/,
    )
  })

  it('warns about outdated manifests with client scripts of resources that changed', async () => {
    const legacy = (...lines: string[]) => [...lines, `client_script 'client.lua'`].join('\n')
    const { files, swap } = swappable(
      new MemoryFileSystem({
        'resources/old/__resource.lua': legacy(),
        'resources/old/client.lua': '',
        'resources/unknown/__resource.lua': legacy(
          `resource_manifest_version 'ffffffff-d386-4d18-afbe-5e627f4af937'`,
        ),
        'resources/unknown/client.lua': '',
        'resources/v1/__resource.lua': legacy(
          `resource_manifest_version '44febabe-d386-4d18-afbe-5e627f4af937'`,
        ),
        'resources/v1/client.lua': '',
        'resources/newest/__resource.lua': legacy(
          `resource_manifest_version '05cfa83c-a124-4cfa-a768-c24a5811d8f9'`,
        ),
        'resources/newest/client.lua': '',
        'resources/server/__resource.lua': `server_script 'server.lua'`,
        'resources/server/server.lua': '',
        'resources/unglobbed/__resource.lua': legacy(),
        'resources/fx/fxmanifest.lua': legacy(`fx_version 'adamant'`, `game 'gta5'`),
        'resources/fx/client.lua': '',
      }),
    )
    const proc = await createProcess({ files })
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources:old] ^3Warning: old has an outdated manifest (__resource.lua instead of fxmanifest.lua)^7',
      '[resources:unknown] ^3Warning: unknown has an outdated manifest (__resource.lua instead of fxmanifest.lua)^7',
      '[resources] ^2Found 7 resources.^7',
      '[resources] ^32 warnings were encountered.^7',
    ])
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] ^2Found 0 new resources, and refreshed 0/7 resources.^7',
    ])
    swap(
      new MemoryFileSystem({
        'resources/old/__resource.lua': legacy(`description 'changed'`),
        'resources/old/client.lua': '',
      }),
    )
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources:old] ^3Warning: old has an outdated manifest (__resource.lua instead of fxmanifest.lua)^7',
      '[resources] ^2Found 0 new resources, and refreshed 1/1 resources.^7',
      '[resources] ^31 warning was encountered.^7',
    ])
  })

  it('adds resources_useSystemChat once, as it first scans', async () => {
    const proc = await serverWith({})
    const { variables } = proc.manager.console
    scan(proc)
    runCommand(proc.manager, 'setr resources_useSystemChat false', 'system.console')
    const flags = variables.flagsOf('resources_useSystemChat')
    scan(proc)
    expect(variables.flagsOf('resources_useSystemChat')).toBe(flags)
    expect(variables.find('resources_useSystemChat')?.value).toBe('false')
  })

  it('adds the resources it finds by their names, whatever other resources provide', async () => {
    const proc = await serverWith({ 'resources/x/fxmanifest.lua': manifest(`description 'x'`) })
    const provider = proc.manager.addResource('p', { metadata: [['provide', 'x']] })
    scan(proc)
    const x = proc.manager.getResource('x', false)!
    expect(x).not.toBe(provider)
    expect(x.entries('description')).toEqual(['x'])
    expect(provider.metadata).toEqual([['provide', 'x']])
  })

  it('stops resources found elsewhere twice when they do not stop, as FiveM does', async () => {
    const { files, swap } = swappable(
      new MemoryFileSystem({ 'resources/a/fxmanifest.lua': manifest() }),
    )
    const proc = await createProcess({ files })
    scan(proc)
    const a = proc.manager.getResource('a')!
    a.start()
    let refused = false
    a.onStop.connect(() => {
      if (refused) return true
      refused = true
      return false
    })
    proc.take()
    swap(new MemoryFileSystem({ 'resources/[x]/a/fxmanifest.lua': manifest() }))
    expect(scan(proc)).toEqual([
      '[resources] ^2Scanning resources.^7',
      '[resources] Stopping resource a',
      '[resources] Stopping resource a',
      '[resources] ^2Found 1 resources.^7',
    ])
  })

  it('says again which entries of manifests that changed have plural names', async () => {
    const plural = manifest(`client_scripts 'client.lua'`)
    const { files, swap } = swappable(
      new MemoryFileSystem({ 'resources/a/fxmanifest.lua': manifest() }),
    )
    const proc = await createProcess({ files })
    scan(proc)
    swap(new MemoryFileSystem({ 'resources/a/fxmanifest.lua': plural }))
    scan(proc)
    scan(proc)
    expect(proc.diagnostics).toHaveLength(1)
    expect(proc.diagnostics[0]).toMatch(/^a: a's manifest adds client_scripts `client\.lua`/)
  })

  it('lets errors of the files through as it reads manifests again', async () => {
    const { files, swap } = swappable(
      new MemoryFileSystem({ 'resources/a/fxmanifest.lua': manifest() }),
    )
    const proc = await createProcess({ files })
    scan(proc)
    const listed = new MemoryFileSystem({ 'resources/a/fxmanifest.lua': manifest() })
    swap({
      list: (path) => listed.list(path),
      read: () => {
        throw new Error('The disk is gone')
      },
      write: () => false,
      makeDirectory: () => {},
      remove: () => false,
      rename: () => false,
      writeAt: () => false,
      size: () => undefined,
      readAt: () => undefined,
      resize: () => false,
    })
    expect(() => proc.manager.scanResources()).toThrow(new Error('The disk is gone'))
  })

  it('lets errors of the files through', async () => {
    const files = new MemoryFileSystem({ 'resources/a/fxmanifest.lua': manifest() })
    const broken: FileSystem = {
      list: (path) => files.list(path),
      read: () => {
        throw new Error('The disk is gone')
      },
      write: () => false,
      makeDirectory: () => {},
      remove: () => false,
      rename: () => false,
      writeAt: () => false,
      size: () => undefined,
      readAt: () => undefined,
      resize: () => false,
    }
    const proc = await createProcess({ files: broken })
    expect(() => proc.manager.scanResources()).toThrow(new Error('The disk is gone'))
  })

  it('belongs to servers', async () => {
    const proc = await createProcess({ side: 'client' })
    expect(() => proc.manager.scanResources()).toThrow(new Error('Only servers scan for resources'))
    runCommand(proc.manager, 'refresh', 'system.console')
    expect(proc.take()).toEqual(['[cmd] No such command refresh.'])
  })
})

describe('Removing resources', () => {
  it('stops them and leaves them uninitialized, but by the names they provide', async () => {
    const proc = await createProcess()
    const { manager } = proc
    const a = manager.addResource('a', { files: {}, metadata: [['provide', 'p']] })
    a.start()
    proc.take()
    manager.removeResource(a)
    expect(proc.take()).toEqual(['[resources] Stopping resource a'])
    expect(a.state).toBe('uninitialized')
    expect(manager.getResource('a', false)).toBe(undefined)
    expect(manager.getResource('p')).toBe(a)
    expect(pathsOf(manager)).toEqual([])
  })
})
