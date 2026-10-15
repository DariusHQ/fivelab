import { normalizePath } from './glob.ts'

/** An entry of a directory. */
export interface FileEntry {
  readonly name: string
  /** Whether the entry is a directory rather than a file. */
  readonly directory: boolean
}

/**
 * The files of a process as its host keeps them, which FiveRunner reads as
 * FiveM reads those of its file system: the files of its resources, and on
 * servers, those of their config. FiveRunner names them by paths that
 * normalizePath normalized, with slashes and no . parts, which are relative
 * to the root of the files unless absolute, such as C:/server or /srv.
 */
export interface FileSystem {
  /**
   * The entries of the directory at `path`, in the order that the host
   * lists them, or undefined if there is no directory there.
   */
  list(path: string): readonly FileEntry[] | undefined
  /** The bytes of the file at `path`, which callers leave as they are, or undefined if there is no file there. */
  read(path: string): Uint8Array | undefined
  /** The length of the file at `path` in bytes, or undefined if there is no file there. */
  size(path: string): number | undefined
  /**
   * A copy of the bytes of the file at `path` from byte `offset`, up to
   * `length` of them, or undefined if there is no file there.
   */
  readAt(path: string, offset: number, length: number): Uint8Array | undefined
  /**
   * Writes `data` to the file at `path`, creating the file or replacing
   * what it has, and returns whether it could, which it cannot without a
   * directory for the file, as FiveM creates none, or with one at `path`.
   */
  write(path: string, data: Uint8Array): boolean
  /**
   * Writes `data` into the file at `path` from byte `offset`, past its end
   * if need be, with zeros between, and returns whether there was a file.
   */
  writeAt(path: string, offset: number, data: Uint8Array): boolean
  /**
   * Makes the file at `path` `length` bytes long, cutting it or adding
   * zeros, and returns whether there was a file.
   */
  resize(path: string, length: number): boolean
  /** Creates the directory at `path`, and those it is in, unless they are there. Throws if a file is. */
  makeDirectory(path: string): void
  /** Removes the file at `path`, and returns whether there was one, as FiveM removes files but no directories. */
  remove(path: string): boolean
  /**
   * Moves the file or the directory at `from` to `to`, and returns whether
   * it could: not onto what is at `to` already, nor into a directory that
   * is not there.
   */
  rename(from: string, to: string): boolean
}

const encoder = new TextEncoder()

/** A file in memory, in a buffer that can have room past its end, for writes to grow into. */
interface StoredFile {
  bytes: Uint8Array
  length: number
  /** Whether read gave out a view of `bytes`, which writes then leave as it is. */
  shared: boolean
}

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
  readonly #files = new Map<string, StoredFile>()

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
    const file = this.#files.get(path)
    if (file === undefined) return undefined
    file.shared = true
    return file.bytes.subarray(0, file.length)
  }

  size(path: string): number | undefined {
    return this.#files.get(path)?.length
  }

  readAt(path: string, offset: number, length: number): Uint8Array | undefined {
    const file = this.#files.get(path)
    if (file === undefined) return undefined
    return file.bytes.slice(Math.min(offset, file.length), Math.min(offset + length, file.length))
  }

  write(path: string, data: Uint8Array): boolean {
    const directory = this.#directories.get(parentOf(path))
    if (directory === undefined || this.#directories.has(path)) return false
    directory.set(nameOf(path), false)
    this.#files.set(path, { bytes: data.slice(), length: data.length, shared: false })
    return true
  }

  writeAt(path: string, offset: number, data: Uint8Array): boolean {
    const file = this.#files.get(path)
    if (file === undefined) return false
    resizeFile(file, Math.max(file.length, offset + data.length))
    file.bytes.set(data, offset)
    return true
  }

  resize(path: string, length: number): boolean {
    const file = this.#files.get(path)
    if (file === undefined) return false
    resizeFile(file, length)
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

  remove(path: string): boolean {
    if (!this.#files.delete(path)) return false
    this.#directories.get(parentOf(path))!.delete(nameOf(path))
    return true
  }

  rename(from: string, to: string): boolean {
    const isFile = this.#files.has(from)
    if (!isFile && !this.#directories.has(from)) return false
    const target = this.#directories.get(parentOf(to))
    if (target === undefined || this.#files.has(to) || this.#directories.has(to)) return false
    // A directory does not move into itself.
    if (!isFile && to.startsWith(`${from}/`)) return false
    this.#directories.get(parentOf(from))!.delete(nameOf(from))
    target.set(nameOf(to), !isFile)
    const moved = (path: string) => path === from || path.startsWith(`${from}/`)
    const renamed = (path: string) => to + path.slice(from.length)
    for (const map of [this.#files, this.#directories] as Map<string, unknown>[]) {
      for (const [path, value] of [...map]) {
        if (!moved(path)) continue
        map.delete(path)
        map.set(renamed(path), value)
      }
    }
    return true
  }
}

/**
 * Makes a file `length` bytes long, with zeros past what it had, in a
 * buffer that read gave out no view of. Growing past its room doubles it,
 * so that files written at their ends copy their bytes only now and then.
 */
function resizeFile(file: StoredFile, length: number): void {
  const room = file.bytes.length
  if (file.shared || length > room) {
    const bytes = new Uint8Array(length > room ? Math.max(length, room * 2) : room)
    bytes.set(file.bytes.subarray(0, file.length))
    file.bytes = bytes
    file.shared = false
  } else if (length > file.length) {
    file.bytes.fill(0, file.length, length)
  }
  file.length = length
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
