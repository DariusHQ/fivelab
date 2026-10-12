import { normalizePath } from './glob.ts'

/** An entry of a directory. */
export interface FileEntry {
  readonly name: string
  /** Whether the entry is a directory rather than a file. */
  readonly directory: boolean
}

/**
 * The files of a process as its host keeps them, which FiveLab reads as
 * FiveM reads those of its file system: the files of its resources, and on
 * servers, those of their config. FiveLab names them by paths that
 * normalizePath normalized, with slashes and no . parts, which are relative
 * to the root of the files unless absolute, such as C:/server or /srv.
 */
export interface FileSystem {
  /**
   * The entries of the directory at `path`, in the order that the host
   * lists them, or undefined if there is no directory there.
   */
  list(path: string): readonly FileEntry[] | undefined
  /** The bytes of the file at `path`, or undefined if there is no file there. */
  read(path: string): Uint8Array | undefined
  /**
   * Writes `data` to the file at `path`, creating the file or replacing
   * what it has, and returns whether it could, which it cannot without a
   * directory for the file, as FiveM creates none, or with one at `path`.
   */
  write(path: string, data: Uint8Array): boolean
  /** Creates the directory at `path`, and those it is in, unless they are there. Throws if a file is. */
  makeDirectory(path: string): void
}

const encoder = new TextEncoder()

/**
 * Files in memory, for hosts that keep none of their own, such as
 * browsers. It has a directory wherever its files are, and those it makes,
 * and lists their entries in the order they came.
 */
export class MemoryFileSystem implements FileSystem {
  /** The entries of each directory by its path: whether each is a directory. */
  readonly #directories = new Map<string, Map<string, boolean>>([
    ['', new Map()],
    ['/', new Map()],
  ])
  readonly #files = new Map<string, Uint8Array>()

  /** Files with `files`, by their paths, with the directories that these name. */
  constructor(files: Readonly<Record<string, string | Uint8Array>> = {}) {
    for (const [path, data] of Object.entries(files)) addFile(this, normalizePath(path), data)
  }

  list(path: string): readonly FileEntry[] | undefined {
    const entries = this.#directories.get(path)
    if (entries === undefined) return undefined
    return Array.from(entries, ([name, directory]) => ({ name, directory }))
  }

  read(path: string): Uint8Array | undefined {
    return this.#files.get(path)
  }

  write(path: string, data: Uint8Array): boolean {
    const directory = this.#directories.get(parentOf(path))
    if (directory === undefined || this.#directories.has(path)) return false
    directory.set(nameOf(path), false)
    this.#files.set(path, data.slice())
    return true
  }

  makeDirectory(path: string): void {
    if (this.#directories.has(path)) return
    if (this.#files.has(path)) throw new Error(`There is a file at ${path}`)
    const parent = parentOf(path)
    this.makeDirectory(parent)
    this.#directories.get(parent)!.set(nameOf(path), true)
    this.#directories.set(path, new Map())
  }
}

/**
 * Adds a file at `path` to `files`, in the directories that its path
 * names, creating those that are not there.
 */
export function addFile(files: FileSystem, path: string, data: string | Uint8Array): void {
  files.makeDirectory(parentOf(path))
  if (!files.write(path, typeof data === 'string' ? encoder.encode(data) : data)) {
    throw new Error(`There is a directory at ${path}`)
  }
}

/** The path of the directory that a normalized path is in: "" for relative paths in none, and / for absolute ones. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return ''
  return slash === 0 ? '/' : path.slice(0, slash)
}

/** The name of the last part of a normalized path. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
