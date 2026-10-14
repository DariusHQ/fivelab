import { parentOf } from './files.ts'
import { normalizePath } from './glob.ts'
import type { ResourceManager } from './manager.ts'

/**
 * Where FiveM's VFS on servers keeps the files of the paths that begin with
 * a prefix: it mounts every resource at @name/ on its directory.
 */
interface Mount {
  readonly prefix: string
  /** The directory in the files of the process that the prefix stands for, with a slash at its end. */
  readonly root: string
}

/** Where the VFS takes the paths of no mount: in the files of the process, from their root. */
const PROCESS_FILES: Mount = { prefix: '', root: '' }

/**
 * The mount that FiveM's VFS gives a path by how it begins: that of the
 * resource whose own name is between its @ and its first slash, or else
 * the files of the process.
 */
function mountOf(manager: ResourceManager, path: string): Mount {
  const prefix = /^@[^/]*\//.exec(path)?.[0]
  if (prefix === undefined) return PROCESS_FILES
  const resource = manager.getResource(prefix.slice(1, -1), false)
  if (resource === undefined) return PROCESS_FILES
  return { prefix, root: `${normalizePath(resource.path)}/` }
}

/**
 * The path in the files of the process of a path on a mount. Like FiveM's
 * VFS, it takes as many characters off the path as the mount's prefix has,
 * whether or not the path begins with that prefix.
 */
function filePath(mount: Mount, path: string): string {
  return normalizePath(mount.root + path.slice(mount.prefix.length))
}

/**
 * The mount of a path of the files of the process, as FiveM's VFS finds one
 * for a path without an @: that of the resource whose directory holds the
 * path, and the path there, which begins with its prefix. There is none
 * for paths outside every resource.
 */
function mountHolding(
  manager: ResourceManager,
  path: string,
): { mount: Mount; path: string } | undefined {
  const place = normalizePath(path)
  for (const resource of manager.resources) {
    const root = `${normalizePath(resource.path)}/`
    if (!place.startsWith(root)) continue
    const prefix = `@${resource.name}/`
    return { mount: { prefix, root }, path: prefix + place.slice(root.length) }
  }
  return undefined
}

/**
 * Whether the resource `current` may write at a path that begins with an
 * @, as FiveM's ScriptingFilesystemAllowWrite says on servers: at
 * @resource/file alone, not the resource itself, of its own resource, or
 * of one that add_filesystem_permission let it write.
 */
function mayWrite(manager: ResourceManager, current: string, path: string): boolean {
  const [name, ...rest] = path.slice(1).split(/[\\/]/)
  if (rest.every((part) => part === '')) return false
  return name === current || manager.filesystemPermissions!.mayWrite(current, name!)
}

/**
 * What FiveM's os library does to the files of a process for the scripts of
 * the resource `current`: it creates directories wherever the VFS puts a
 * path, as it checks no permissions, though not in directories that are not
 * there, and removes and moves files only where the resource may write.
 */
export function osFiles(manager: ResourceManager, current: string) {
  const { files } = manager
  // Paths with an @ go where they begin, and the others to the resource that holds them.
  const locate = (path: string) =>
    path.startsWith('@') ? { mount: mountOf(manager, path), path } : mountHolding(manager, path)
  return {
    createDirectory(path: string): 'created' | 'exists' | 'failed' {
      // FiveM first turns the path into a directory's, with forward slashes and one at its end.
      const directory = `${path.replaceAll('\\', '/')}/`
      const resolved = filePath(mountOf(manager, directory), directory)
      if (files.list(resolved) !== undefined) return 'exists'
      if (files.list(parentOf(resolved)) === undefined || files.read(resolved) !== undefined) {
        return 'failed'
      }
      files.makeDirectory(resolved)
      return 'created'
    },
    remove(path: string): boolean {
      const located = locate(path)
      if (located === undefined || !mayWrite(manager, current, located.path)) return false
      return files.remove(filePath(located.mount, located.path))
    },
    rename(from: string, to: string): boolean {
      const source = locate(from)
      const target = locate(to)
      if (source === undefined || target === undefined) return false
      if (!mayWrite(manager, current, source.path) || !mayWrite(manager, current, target.path)) {
        return false
      }
      // FiveM moves files on the mount of the source, and takes the target there too.
      return files.rename(filePath(source.mount, source.path), filePath(source.mount, target.path))
    },
  }
}
