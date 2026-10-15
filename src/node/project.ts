import { basename } from 'node:path'

import { MemoryFileSystem, type FileSource } from '../core/engine/index.ts'
import { compareUtf8 } from '../core/libc.ts'
import type { Project } from '../runner/index.ts'
import { DiskSource } from './disk.ts'

/** A FiveM project in a directory of the host, whose tests the runner runs. */
export interface LocalProject extends Project {
  /** A resource and its tests, or a server, with a resources directory. */
  readonly kind: 'resource' | 'server'
  /** The name of the resource, for projects that are one: that of their directory. */
  readonly name?: string
  /** The files of the directory, test files too, which it reads as they are first needed. */
  readonly source: DiskSource
}

/** Test files end in this. */
const TEST_FILE = '.test.lua'

/**
 * The FiveM project in the directory `root` of the host, if there is one:
 * a resource, when the directory has an fxmanifest.lua or a
 * __resource.lua, which servers of tests have as resources/ and the name
 * of the directory, and ensure; or else a server, when the directory has
 * a resources directory, which servers of tests run in, with the
 * server.cfg of the directory, if it has one. Servers of tests see the
 * files of the project but its test files, and keep what they write in
 * memory.
 */
export function openProject(root: string): LocalProject | undefined {
  const source = new DiskSource(root)
  const entries = source.list('')
  const has = (name: string, directory: boolean) =>
    entries.some((entry) => entry.name === name && entry.directory === directory)
  const project = withoutTests(source)
  if (has('fxmanifest.lua', false) || has('__resource.lua', false)) {
    const name = basename(root)
    return {
      kind: 'resource',
      name,
      source,
      files: () => mounted(`resources/${name}`, project),
      commands: [`ensure "${name}"`],
    }
  }
  if (has('resources', true)) {
    return {
      kind: 'server',
      source,
      files: () => mounted('', project),
      commands: has('server.cfg', false) ? ['exec server.cfg'] : [],
    }
  }
  return undefined
}

/**
 * The paths of the test files in the directory at `path` of a source, and
 * in the directories in it, but for node_modules and those whose names
 * start with a dot, in the order of their bytes.
 */
export function findTestFiles(source: FileSource, path = ''): string[] {
  const found: string[] = []
  const visit = (directory: string) => {
    for (const { name, directory: isDirectory } of source.list(directory)) {
      const at = directory === '' ? name : `${directory}/${name}`
      if (!isDirectory) {
        if (name.endsWith(TEST_FILE)) found.push(at)
      } else if (name !== 'node_modules' && !name.startsWith('.')) {
        visit(at)
      }
    }
  }
  visit(path)
  return found.sort(compareUtf8)
}

/** Files in memory with those of `source` at `path`. */
function mounted(path: string, source: FileSource): MemoryFileSystem {
  const files = new MemoryFileSystem()
  files.mount(path, source)
  return files
}

/** The files of `source` but its test files. */
function withoutTests(source: FileSource): FileSource {
  return {
    list: (path) =>
      source.list(path).filter(({ name, directory }) => directory || !name.endsWith(TEST_FILE)),
    read: (path) => source.read(path),
  }
}
