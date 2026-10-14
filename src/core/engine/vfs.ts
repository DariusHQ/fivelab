import { parentOf } from './files.ts'
import { normalizePath } from './glob.ts'
import type { ResourceManager } from './manager.ts'

/**
 * The path in the files of the process of a path that scripts give, as
 * FiveM's VFS takes it: @resource/file is in the resource of that name,
 * and other paths are the files of the process, from their root. There is
 * none for the @ paths of resources that are not there.
 */
export function vfsPath(manager: ResourceManager, path: string): string | undefined {
  if (!path.startsWith('@')) return normalizePath(path)
  const slash = path.search(/[\\/]/)
  const name = slash === -1 ? path.slice(1) : path.slice(1, slash)
  const resource = manager.getResource(name)
  if (resource === undefined) return undefined
  const rest = slash === -1 ? '' : path.slice(slash + 1)
  return normalizePath(`${normalizePath(resource.path)}/${rest}`)
}

/**
 * Whether the resource `current` may write at a path that scripts give, as
 * FiveM's ScriptingFilesystemAllowWrite says: at @resource/file alone, of
 * its own resource, or of one that add_filesystem_permission let it write.
 */
export function mayWritePath(manager: ResourceManager, current: string, path: string): boolean {
  if (!path.startsWith('@')) return false
  const [name = '', ...rest] = path.slice(1).split(/[\\/]/)
  if (name === '' || rest.every((part) => part === '')) return false
  return name === current || (manager.filesystemPermissions?.mayWrite(current, name) ?? false)
}

/**
 * What FiveM's os library does to the files of a process for the scripts of
 * the resource `current`: it creates directories wherever the VFS has a
 * path, as no permission checks, though not in directories that are not
 * there, and removes and moves files only where the resource may write.
 */
export function osFiles(manager: ResourceManager, current: string) {
  const { files } = manager
  return {
    createDirectory(path: string): 'created' | 'exists' | 'failed' {
      const resolved = vfsPath(manager, path)
      if (resolved === undefined) return 'failed'
      if (files.list(resolved) !== undefined) return 'exists'
      if (files.list(parentOf(resolved)) === undefined || files.read(resolved) !== undefined) {
        return 'failed'
      }
      files.makeDirectory(resolved)
      return 'created'
    },
    remove(path: string): boolean {
      const resolved = vfsPath(manager, path)
      return (
        mayWritePath(manager, current, path) && resolved !== undefined && files.remove(resolved)
      )
    },
    rename(from: string, to: string): boolean {
      const source = vfsPath(manager, from)
      const target = vfsPath(manager, to)
      if (!mayWritePath(manager, current, from) || !mayWritePath(manager, current, to)) return false
      return source !== undefined && target !== undefined && files.rename(source, target)
    },
  }
}
