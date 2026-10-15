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

/**
 * Files that a MemoryFileSystem can take as it needs them, such as those
 * of a directory of the host, by their paths in the source: "" for its
 * root, and the names of what is in it below that, with slashes.
 */
export interface FileSource {
  /** The entries of the directory at `path`, which the directory it is in listed. */
  list(path: string): readonly FileEntry[]
  /**
   * The bytes of the file at `path`, which the directory it is in listed,
   * and which the file system leaves as they are.
   */
  read(path: string): Uint8Array
}

const encoder = new TextEncoder()

/** A file in memory, in a buffer that can have room past its end, for writes to grow into. */
interface StoredFile {
  bytes: Uint8Array
  length: number
  /** Whether something else has a view of `bytes`, a source or a caller of read, so that writes leave it as it is. */
  shared: boolean
}

/** Where a directory or a file of a MemoryFileSystem is in a source, until it takes what it has from there. */
interface SourceEntry {
  readonly source: FileSource
  readonly path: string
}

/**
 * Files in memory, for hosts that keep none of their own, such as
 * browsers, and for those whose files scripts are to leave as they are,
 * which it takes from sources as it needs them: each directory of a
 * source as its entries are first needed, and each file as its bytes are,
 * and what is written to them stays in memory. It has a directory wherever
 * its files are, and those it makes, and lists their entries in the order
 * they came, those of a source in the order the source gave them.
 */
export class MemoryFileSystem implements FileSystem {
  /** The entries of each directory by its path, but those of sources yet to list: whether each is a directory. */
  readonly #directories = new Map<string, Map<string, boolean>>([
    ['', new Map()],
    ['/', new Map()],
  ])
  readonly #files = new Map<string, StoredFile>()
  /**
   * The directories that are yet to list the entries of their sources, by
   * their paths, which turn up as the directories they are in list theirs.
   */
  readonly #unlisted = new Map<string, SourceEntry>()
  /** The files that are yet to read the bytes of their sources, by their paths. */
  readonly #unread = new Map<string, SourceEntry>()

  /** Files with `files`, by their paths, with the directories that these name. */
  constructor(files: Readonly<Record<string, string | Uint8Array>> = {}) {
    for (const [path, data] of Object.entries(files)) addFile(this, normalizePath(path), data)
  }

  /**
   * Gives the directory at `path`, which it creates with those it is in
   * unless they are there, the files of `source`, which it takes as it
   * needs them. Throws if the directory has entries, or if a file is there.
   */
  mount(path: string, source: FileSource): void {
    const directory = normalizePath(path)
    this.makeDirectory(directory)
    if (this.#directory(directory)!.size > 0) {
      throw new Error(`The directory at ${directory} is not empty`)
    }
    this.#directories.delete(directory)
    this.#unlisted.set(directory, { source, path: '' })
  }

  list(path: string): readonly FileEntry[] | undefined {
    const entries = this.#directory(path)
    if (entries === undefined) return undefined
    return Array.from(entries, ([name, directory]) => ({ name, directory }))
  }

  read(path: string): Uint8Array | undefined {
    const file = this.#file(path)
    if (file === undefined) return undefined
    file.shared = true
    return file.bytes.subarray(0, file.length)
  }

  size(path: string): number | undefined {
    return this.#file(path)?.length
  }

  readAt(path: string, offset: number, length: number): Uint8Array | undefined {
    const file = this.#file(path)
    if (file === undefined) return undefined
    return file.bytes.slice(Math.min(offset, file.length), Math.min(offset + length, file.length))
  }

  write(path: string, data: Uint8Array): boolean {
    const directory = this.#directory(parentOf(path))
    if (directory === undefined || this.#entry(path) === true) return false
    directory.set(nameOf(path), false)
    this.#unread.delete(path)
    this.#files.set(path, { bytes: new Uint8Array(data), length: data.length, shared: false })
    return true
  }

  writeAt(path: string, offset: number, data: Uint8Array): boolean {
    const file = this.#file(path)
    if (file === undefined) return false
    resizeFile(file, Math.max(file.length, offset + data.length))
    file.bytes.set(data, offset)
    return true
  }

  resize(path: string, length: number): boolean {
    const file = this.#file(path)
    if (file === undefined) return false
    resizeFile(file, length)
    return true
  }

  makeDirectory(path: string): void {
    const entry = this.#entry(path)
    if (entry === true) return
    if (entry === false) throw new Error(`There is a file at ${path}`)
    const parent = parentOf(path)
    this.makeDirectory(parent)
    this.#directory(parent)!.set(nameOf(path), true)
    this.#directories.set(path, new Map())
  }

  remove(path: string): boolean {
    if (this.#entry(path) !== false) return false
    this.#directory(parentOf(path))!.delete(nameOf(path))
    this.#files.delete(path)
    this.#unread.delete(path)
    return true
  }

  rename(from: string, to: string): boolean {
    const directory = this.#entry(from)
    if (directory === undefined) return false
    const target = this.#directory(parentOf(to))
    if (target === undefined || this.#entry(to) !== undefined) return false
    // A directory does not move into itself, and nothing is in a file.
    if (to.startsWith(`${from}/`)) return false
    this.#directory(parentOf(from))!.delete(nameOf(from))
    target.set(nameOf(to), directory)
    const moved = (path: string) => path === from || path.startsWith(`${from}/`)
    const renamed = (path: string) => to + path.slice(from.length)
    // What is yet to come from sources moves too, and comes from where it was there.
    const maps = [this.#files, this.#directories, this.#unlisted, this.#unread]
    for (const map of maps as Map<string, unknown>[]) {
      for (const [path, value] of [...map]) {
        if (!moved(path)) continue
        map.delete(path)
        map.set(renamed(path), value)
      }
    }
    return true
  }

  /** Whether the entry at `path` is a directory, or undefined if there is none. */
  #entry(path: string): boolean | undefined {
    if (path === '' || path === '/') return true
    return this.#directory(parentOf(path))?.get(nameOf(path))
  }

  /**
   * The entries of the directory at `path`, if there is one, once it
   * listed those of its source, if it was yet to.
   */
  #directory(path: string): Map<string, boolean> | undefined {
    const listed = this.#directories.get(path)
    if (listed !== undefined) return listed
    // The directories of sources turn up as those they are in list their entries.
    if (this.#entry(path) !== true) return undefined
    const { source, path: inSource } = this.#unlisted.get(path)!
    const entries = new Map<string, boolean>()
    for (const { name, directory } of source.list(inSource)) {
      entries.set(name, directory)
      const at = childOf(path, name)
      const entry = { source, path: inSource === '' ? name : `${inSource}/${name}` }
      if (directory) this.#unlisted.set(at, entry)
      else this.#unread.set(at, entry)
    }
    this.#unlisted.delete(path)
    this.#directories.set(path, entries)
    return entries
  }

  /** The file at `path`, if there is one, once it read the bytes of its source, if it was yet to. */
  #file(path: string): StoredFile | undefined {
    const stored = this.#files.get(path)
    if (stored !== undefined) return stored
    if (this.#entry(path) !== false) return undefined
    const { source, path: inSource } = this.#unread.get(path)!
    const bytes = source.read(inSource)
    // A plain Uint8Array of the same bytes, whose slice copies them, where that of Node's Buffers gives views.
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
    const file = { bytes: view, length: bytes.length, shared: true }
    this.#unread.delete(path)
    this.#files.set(path, file)
    return file
  }
}

/**
 * Makes a file `length` bytes long, with zeros past what it had, in a
 * buffer that nothing else has a view of. Growing past its room doubles it,
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

/**
 * Orders names as NTFS lists the entries of a directory, which
 * FindFirstFile gives in that order: by their UTF-16 code units in upper
 * case, each as one.
 */
export function ntfsOrder(a: string, b: string): number {
  const upper = (unit: number) => {
    const mapped = String.fromCharCode(unit).toUpperCase()
    return mapped.length === 1 ? mapped.charCodeAt(0) : unit
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = upper(a.charCodeAt(i)) - upper(b.charCodeAt(i))
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

/** The path of the directory that a normalized path is in: "" for relative paths in none, and / for absolute ones. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  if (slash === -1) return ''
  return slash === 0 ? '/' : path.slice(0, slash)
}

/** The path of the entry `name` of the directory at a normalized path. */
function childOf(path: string, name: string): string {
  if (path === '') return name
  return path === '/' ? `/${name}` : `${path}/${name}`
}

/** The name of the last part of a normalized path. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
