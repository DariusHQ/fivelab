import { readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'

import { parentOf } from '../core/engine/files.ts'
import type { FileEntry, FileSource } from '../core/engine/index.ts'

/**
 * The files of a directory of the host, as a source of MemoryFileSystems,
 * which reads each directory and each file of it once, as it is first
 * needed, and keeps what it read: what is there then is what the file
 * systems that mount it see, whatever changes on the disk after.
 *
 * It follows symbolic links, as Windows follows them and junctions, but
 * for those to the directories they are in or to those above, whose
 * entries would go on without end, and those that lead nowhere. It leaves
 * out what is neither a file nor a directory, such as sockets.
 */
export class DiskSource implements FileSource {
  readonly #root: string
  readonly #entries = new Map<string, readonly FileEntry[]>()
  readonly #bytes = new Map<string, Uint8Array>()

  /** The files of the directory at `root`, a path of the host. */
  constructor(root: string) {
    this.#root = root
  }

  list(path: string): readonly FileEntry[] {
    let entries = this.#entries.get(path)
    if (entries === undefined) {
      entries = readdirSync(join(this.#root, path), { withFileTypes: true }).flatMap((entry) => {
        const directory = this.#isDirectory(path, entry)
        return directory === undefined ? [] : [{ name: entry.name, directory }]
      })
      this.#entries.set(path, entries)
    }
    return entries
  }

  read(path: string): Uint8Array {
    let bytes = this.#bytes.get(path)
    if (bytes === undefined) {
      bytes = readFileSync(join(this.#root, path))
      this.#bytes.set(path, bytes)
    }
    return bytes
  }

  /**
   * Whether an entry of the directory at `path` is a directory rather than
   * a file, or undefined if the source leaves it out.
   */
  #isDirectory(path: string, entry: Dirent): boolean | undefined {
    if (entry.isFile()) return false
    if (entry.isDirectory()) return true
    // The rest are links, which lead to a file, a directory or nowhere, or neither, as sockets are.
    const link = join(this.#root, path, entry.name)
    const target = statOf(link)
    if (target?.isFile()) return false
    if (!target?.isDirectory()) return undefined
    // Links to the directories they are in, or to those above, would have entries without end.
    const real = realpathSync.native(link)
    for (let at = path; ; at = parentOf(at)) {
      if (realpathSync.native(join(this.#root, at)) === real) return undefined
      if (at === '') return true
    }
  }
}

/** What is at `path` of the host, or undefined if it leads nowhere, as links in a loop do. */
function statOf(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}
