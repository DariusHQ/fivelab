import type { FileSystem } from './files.ts'

/**
 * What a handle may do to its file. Every handle reads, and those that
 * write write where they are, or only at the end, for handles that append.
 */
export type FileAccess = 'read' | 'write' | 'append'

/** What SetFilePointer returns when it fails, which also caps the positions it reports. */
const INVALID_SET_FILE_POINTER = 0xffff_ffff

/**
 * The files a process has open, as Windows keeps them for FiveM's server:
 * handles at positions of their own over files whose writes all of them
 * see at once. Handles that open files share reads and writes with the
 * others, while those that create files share only reads, and none share
 * removing or moving their files, as FiveM's VFS opens them.
 */
export class OpenFiles {
  readonly #files: FileSystem
  readonly #handles = new Map<string, Set<FileHandle>>()

  constructor(files: FileSystem) {
    this.#files = files
  }

  /**
   * Opens the file at `path` as CreateFileW opens files that are there:
   * none if there is no file, or if the handle would write while one that
   * created the file shares no writes.
   */
  openExisting(path: string, access: FileAccess): FileHandle | undefined {
    if (this.#files.size(path) === undefined) return undefined
    const handles = this.#handles.get(path)
    if (access !== 'read' && handles !== undefined) {
      for (const handle of handles) if (!handle.sharesWrites) return undefined
    }
    return this.#open(path, access, true)
  }

  /**
   * Creates the file at `path` as CreateFileW creates new ones: none if a
   * file is there already, or a directory, or there is no directory for it.
   */
  createNew(path: string, access: 'write' | 'append'): FileHandle | undefined {
    if (this.#files.size(path) !== undefined) return undefined
    if (!this.#files.write(path, new Uint8Array())) return undefined
    return this.#open(path, access, false)
  }

  /**
   * Whether a handle has the file at `path` open, or one in the directory
   * at `path`, which Windows then neither removes nor moves.
   */
  inUse(path: string): boolean {
    for (const open of this.#handles.keys()) {
      if (open === path || open.startsWith(`${path}/`)) return true
    }
    return false
  }

  #open(path: string, access: FileAccess, sharesWrites: boolean): FileHandle {
    let handles = this.#handles.get(path)
    if (handles === undefined) this.#handles.set(path, (handles = new Set()))
    const open = handles
    const handle = new FileHandle(this.#files, path, access, sharesWrites, () => {
      open.delete(handle)
      if (open.size === 0) this.#handles.delete(path)
    })
    open.add(handle)
    return handle
  }
}

/**
 * A file that a process has open, through a handle at a position of its
 * own, over the file as it is at the time, as Windows has handles.
 */
export class FileHandle {
  readonly path: string
  readonly access: FileAccess
  /** Whether other handles may write the file while this one is open, which handles that create files forbid. */
  readonly sharesWrites: boolean
  readonly #files: FileSystem
  readonly #onClose: () => void
  #position = 0
  #open = true

  constructor(
    files: FileSystem,
    path: string,
    access: FileAccess,
    sharesWrites: boolean,
    onClose: () => void,
  ) {
    this.#files = files
    this.path = path
    this.access = access
    this.sharesWrites = sharesWrites
    this.#onClose = onClose
  }

  /** The position of the handle in its file, from the start, which can be past the end. */
  get position(): number {
    return this.#position
  }

  /** The length of the file, as GetFileSize gives it. */
  length(): number {
    return this.#files.size(this.path) ?? 0
  }

  /** Reads up to `count` bytes from the position, which then moves past them. */
  read(count: number): Uint8Array {
    const bytes = this.#files.readAt(this.path, this.#position, count) ?? new Uint8Array()
    this.#position += bytes.length
    return bytes
  }

  /**
   * Writes `bytes` at the position, past zeros if it is past the end, or
   * at the end for handles that append, and moves the position past them.
   * Handles that only read write nothing, as WriteFile fails for them.
   */
  write(bytes: Uint8Array): boolean {
    if (this.access === 'read') return false
    const at = this.access === 'append' ? this.length() : this.#position
    if (!this.#files.writeAt(this.path, at, bytes)) return false
    this.#position = at + bytes.length
    return true
  }

  /**
   * Moves the position as SetFilePointer does without its high part: by
   * the low 32 bits of `offset` as a signed number, from the start of the
   * file, the position or the end. It returns the position, or 0xFFFFFFFF
   * for one before the start or past what 32 bits hold, where it stays.
   */
  seek(offset: bigint, from: 'set' | 'cur' | 'end'): number {
    const base = from === 'set' ? 0 : from === 'cur' ? this.#position : this.length()
    const position = base + Number(BigInt.asIntN(32, offset))
    if (position < 0 || position >= INVALID_SET_FILE_POINTER) return INVALID_SET_FILE_POINTER
    this.#position = position
    return position
  }

  /**
   * Makes the file `length` bytes long, as SetFilePointerEx and then
   * SetEndOfFile do: the position moves there either way, while only
   * handles that write anywhere in the file change its length.
   */
  truncate(length: number): boolean {
    this.#position = length
    return this.access === 'write' && this.#files.resize(this.path, length)
  }

  /** Flushes the file, as FlushFileBuffers does, which fails for handles that only read. */
  flush(): boolean {
    return this.access !== 'read'
  }

  /** Closes the handle, which keeps other handles from the file no longer. */
  close(): void {
    if (!this.#open) return
    this.#open = false
    this.#onClose()
  }
}
