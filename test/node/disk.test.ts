import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MemoryFileSystem, type FileEntry } from '../../src/core/engine/index.ts'
import { DiskSource } from '../../src/node/disk.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fiverunner-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes `files` in the root, by their paths there. */
function write(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/** Links `path` in the root to `target` there, with a junction, which Windows lets anyone create. */
function junction(target: string, path: string): void {
  symlinkSync(join(root, target), join(root, path), 'junction')
}

/** The names of entries in the order of their bytes, those of directories with a slash. */
function names(entries: readonly FileEntry[]): string[] {
  return entries.map(({ name, directory }) => (directory ? `${name}/` : name)).sort()
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('DiskSource', () => {
  it('lists the directories of the host and reads their files', () => {
    write({ 'a.txt': 'a', 'd/b.txt': 'b', 'd/e/c.txt': 'c' })
    mkdirSync(join(root, 'empty'))
    const source = new DiskSource(root)
    expect([
      names(source.list('')),
      names(source.list('d')),
      names(source.list('d/e')),
      names(source.list('empty')),
      decode(source.read('a.txt')),
      decode(source.read('d/e/c.txt')),
    ]).toEqual([['a.txt', 'd/', 'empty/'], ['b.txt', 'e/'], ['c.txt'], [], 'a', 'c'])
  })

  it('keeps what it first read, whatever changes on the disk after', () => {
    write({ 'a.txt': 'a' })
    const source = new DiskSource(root)
    const first = [names(source.list('')), decode(source.read('a.txt'))]
    write({ 'a.txt': 'changed', 'b.txt': 'b' })
    expect([names(source.list('')), decode(source.read('a.txt'))]).toEqual(first)
    expect(first).toEqual([['a.txt'], 'a'])
  })

  it('follows links to directories, but not those to where they are or above, nor those that lead nowhere', () => {
    write({ 'd/b.txt': 'b', 'other/c.txt': 'c', 'x/a.txt': 'a', 'y/b.txt': 'b' })
    junction('other', 'd/other')
    junction('d', 'd/self')
    junction('', 'd/root')
    junction('missing', 'd/missing')
    // Links that lead back through others.
    junction('y', 'x/y')
    junction('x', 'y/x')
    const source = new DiskSource(root)
    expect([
      names(source.list('d')),
      names(source.list('d/other')),
      decode(source.read('d/other/c.txt')),
      names(source.list('x')),
      names(source.list('x/y')),
    ]).toEqual([['b.txt', 'other/'], ['c.txt'], 'c', ['a.txt', 'y/'], ['b.txt']])
  })

  it.skipIf(process.platform === 'win32')(
    'follows symbolic links to files, and leaves out links in loops and sockets',
    async () => {
      write({ 'a.txt': 'a' })
      symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'))
      symlinkSync(join(root, 'loop'), join(root, 'loop'))
      const server = createServer()
      await new Promise<void>((resolve) => server.listen(join(root, 'socket'), resolve))
      try {
        const source = new DiskSource(root)
        expect([names(source.list('')), decode(source.read('link.txt'))]).toEqual([
          ['a.txt', 'link.txt'],
          'a',
        ])
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    },
  )

  it('gives memory file systems the files of the host, which keep what is written in memory', () => {
    write({ 'a.txt': 'a' })
    const files = new MemoryFileSystem()
    files.mount('m', new DiskSource(root))
    const encode = (text: string) => new TextEncoder().encode(text)
    expect([files.write('m/a.txt', encode('new')), files.write('m/b.txt', encode('b'))]).toEqual([
      true,
      true,
    ])
    expect([
      decode(files.read('m/a.txt')!),
      names(files.list('m')!),
      readdirSync(root),
      readFileSync(join(root, 'a.txt'), 'utf8'),
    ]).toEqual(['new', ['a.txt', 'b.txt'], ['a.txt'], 'a'])
  })
})
