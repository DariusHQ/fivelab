import { describe, expect, it } from 'vitest'

import {
  addFile,
  MemoryFileSystem,
  parentOf,
  type FileSource,
} from '../../src/core/engine/files.ts'

const encode = (text: string) => new TextEncoder().encode(text)

describe('MemoryFileSystem', () => {
  it('has directories where its files are, with their entries in the order they came', () => {
    const files = new MemoryFileSystem({
      './a//b.txt': 'b',
      'a/c/d.bin': new Uint8Array([0, 255]),
      'e.txt': '',
    })
    expect(files.list('')).toEqual([
      { name: 'a', directory: true },
      { name: 'e.txt', directory: false },
    ])
    expect(files.list('a')).toEqual([
      { name: 'b.txt', directory: false },
      { name: 'c', directory: true },
    ])
    expect(files.list('a/c')).toEqual([{ name: 'd.bin', directory: false }])
    expect(files.list('a/b.txt')).toBe(undefined)
    expect(files.list('missing')).toBe(undefined)
    expect(files.read('a/b.txt')).toEqual(encode('b'))
    expect(files.read('a/c/d.bin')).toEqual(new Uint8Array([0, 255]))
    expect(files.read('a')).toBe(undefined)
    expect(files.read('missing.txt')).toBe(undefined)
  })

  it('keeps absolute paths under the roots they name', () => {
    const files = new MemoryFileSystem({ 'C:/server/x.txt': 'x', '/srv/y.txt': 'y' })
    expect(files.list('')).toEqual([{ name: 'C:', directory: true }])
    expect(files.list('C:/server')).toEqual([{ name: 'x.txt', directory: false }])
    expect(files.list('/')).toEqual([{ name: 'srv', directory: true }])
    expect(files.read('/srv/y.txt')).toEqual(encode('y'))
  })

  it('writes files only in directories that are there, and not over directories', () => {
    const files = new MemoryFileSystem({ 'a/b.txt': 'b' })
    expect(files.write('a/c.txt', encode('c'))).toBe(true)
    expect(files.write('a/b.txt', encode('new'))).toBe(true)
    expect(files.write('missing/x.txt', encode('x'))).toBe(false)
    expect(files.write('a', encode('x'))).toBe(false)
    expect(files.write('', encode('x'))).toBe(false)
    expect(files.read('a/b.txt')).toEqual(encode('new'))
    expect(files.read('a/c.txt')).toEqual(encode('c'))
    expect(files.list('a')).toEqual([
      { name: 'b.txt', directory: false },
      { name: 'c.txt', directory: false },
    ])
    expect(files.list('missing')).toBe(undefined)
  })

  it('keeps what it writes, whatever happens to the bytes it was given', () => {
    const files = new MemoryFileSystem()
    const data = new Uint8Array([1, 2])
    files.write('x.bin', data)
    data[0] = 9
    // Node's Buffers give views of themselves where Uint8Arrays give copies.
    const buffer = Buffer.from([3, 4])
    files.write('y.bin', buffer)
    buffer[0] = 9
    expect(files.read('x.bin')).toEqual(new Uint8Array([1, 2]))
    expect(files.read('y.bin')).toEqual(new Uint8Array([3, 4]))
  })

  it('writes into files at offsets, with zeros past their ends, and resizes them', () => {
    const files = new MemoryFileSystem({ 'a.txt': 'abc', d: '' })
    files.makeDirectory('d2')
    const steps = [
      files.writeAt('a.txt', 1, encode('XY')),
      files.read('a.txt'),
      files.writeAt('a.txt', 5, encode('Z')),
      files.read('a.txt'),
      files.resize('a.txt', 2),
      files.read('a.txt'),
      files.resize('a.txt', 4),
      files.read('a.txt'),
      files.writeAt('none.txt', 0, encode('x')),
      files.resize('d2', 1),
      files.read('none.txt'),
    ]
    expect(steps).toEqual([
      true,
      encode('aXY'),
      true,
      encode('aXY\0\0Z'),
      true,
      encode('aX'),
      true,
      encode('aX\0\0'),
      false,
      false,
      undefined,
    ])
  })

  it('tells the sizes of files and reads copies of their parts', () => {
    const files = new MemoryFileSystem({ 'a.txt': 'abcd', 'd/x': '' })
    const part = files.readAt('a.txt', 1, 2)!
    files.writeAt('a.txt', 1, encode('ZZ'))
    expect([
      files.size('a.txt'),
      files.size('d'),
      files.size('none'),
      part,
      files.readAt('a.txt', 2, 10),
      files.readAt('a.txt', 9, 1),
      files.readAt('d', 0, 1),
    ]).toEqual([4, undefined, undefined, encode('bc'), encode('Zd'), encode(''), undefined])
  })

  it('keeps the bytes it read as they were, whatever is written after', () => {
    const files = new MemoryFileSystem({ 'a.txt': 'abc' })
    const first = files.read('a.txt')!
    files.writeAt('a.txt', 0, encode('X'))
    const second = files.read('a.txt')!
    files.resize('a.txt', 1)
    files.resize('a.txt', 3)
    const third = files.read('a.txt')!
    files.writeAt('a.txt', 3, encode('!'))
    expect([first, second, third, files.read('a.txt')]).toEqual([
      encode('abc'),
      encode('Xbc'),
      encode('X\0\0'),
      encode('X\0\0!'),
    ])
  })

  it('appends to files in place, with room that doubles as they grow', () => {
    const files = new MemoryFileSystem({ 'log.txt': '', 'abc.txt': '' })
    let length = 0
    for (let i = 0; i < 1000; i++) {
      const line = encode(`line ${i}\n`)
      files.writeAt('log.txt', length, line)
      length += line.length
    }
    const text = new TextDecoder().decode(files.read('log.txt'))
    expect([text.length, text.slice(0, 7), text.slice(-9)]).toEqual([
      length,
      'line 0\n',
      'line 999\n',
    ])
    // Bytes written one at a time make room for 1, 2 and then 4, which read gives a view of.
    for (const [offset, letter] of ['a', 'b', 'c'].entries()) {
      files.writeAt('abc.txt', offset, encode(letter))
    }
    const abc = files.read('abc.txt')!
    expect([abc, abc.buffer.byteLength]).toEqual([encode('abc'), 4])
  })

  it('makes directories with those they are in, but not over files', () => {
    const files = new MemoryFileSystem({ 'a/b.txt': 'b' })
    files.makeDirectory('a/x/y')
    files.makeDirectory('a/x')
    expect(files.list('a')).toEqual([
      { name: 'b.txt', directory: false },
      { name: 'x', directory: true },
    ])
    expect(files.list('a/x')).toEqual([{ name: 'y', directory: true }])
    expect(files.list('a/x/y')).toEqual([])
    expect(() => files.makeDirectory('a/b.txt/c')).toThrow(new Error('There is a file at a/b.txt'))
  })

  it('removes files, but no directories', () => {
    const files = new MemoryFileSystem({ 'a/b.txt': 'b', 'a/c/d.txt': 'd' })
    expect([files.remove('a/b.txt'), files.remove('a/b.txt'), files.remove('a/c')]).toEqual([
      true,
      false,
      false,
    ])
    expect([files.list('a'), files.read('a/b.txt'), files.read('a/c/d.txt')]).toEqual([
      [{ name: 'c', directory: true }],
      undefined,
      encode('d'),
    ])
  })

  it('moves files and directories with what they hold, but not onto what is there', () => {
    const files = new MemoryFileSystem({
      'a/b.txt': 'b',
      'a/c/d.txt': 'd',
      'a/c/e/f.txt': 'f',
      'x/y.txt': 'y',
    })
    const results = [
      files.rename('a/b.txt', 'x/b.txt'),
      files.rename('a/c', 'x/c'),
      files.rename('x/y.txt', 'x/b.txt'),
      files.rename('x/y.txt', 'x/c'),
      files.rename('x/y.txt', 'z/y.txt'),
      files.rename('x/c', 'x/c/inside'),
      files.rename('a/none.txt', 'x/none.txt'),
    ]
    expect(results).toEqual([true, true, false, false, false, false, false])
    expect([
      files.list('a'),
      files.list('x'),
      files.read('x/c/d.txt'),
      files.read('x/c/e/f.txt'),
      files.list('x/c/e'),
      files.list('a/c'),
      files.read('a/c/d.txt'),
    ]).toEqual([
      [],
      [
        { name: 'y.txt', directory: false },
        { name: 'b.txt', directory: false },
        { name: 'c', directory: true },
      ],
      encode('d'),
      encode('f'),
      [{ name: 'f.txt', directory: false }],
      undefined,
      undefined,
    ])
  })
})

/**
 * A source of `files`, by their paths in it, which logs what is listed and
 * read of it, and keeps the bytes it gives as Node's Buffers.
 */
function logged(files: Record<string, string>): {
  source: FileSource
  log: string[]
  kept: Map<string, Buffer>
} {
  const backing = new MemoryFileSystem(files)
  const log: string[] = []
  const kept = new Map<string, Buffer>()
  const source: FileSource = {
    list: (path) => {
      log.push(`list ${path}`)
      return backing.list(path)!
    },
    read: (path) => {
      log.push(`read ${path}`)
      const bytes = kept.get(path) ?? Buffer.from(backing.read(path)!)
      kept.set(path, bytes)
      return bytes
    },
  }
  return { source, log, kept }
}

describe('MemoryFileSystem with sources', () => {
  it('lists the directories of sources and reads their files once, as it first needs them', () => {
    const { source, log } = logged({ 'a.txt': 'a', 'd/b.txt': 'bb', 'd/e/c.txt': 'c' })
    const files = new MemoryFileSystem({ 'own.txt': 'own' })
    files.mount('./m/', source)
    expect(log).toEqual([])
    expect([
      files.list(''),
      files.list('m/none'),
      files.read('m/d/b.txt'),
      files.size('m/a.txt'),
      files.read('m/d/e'),
      files.list('m/d'),
      files.readAt('m/d/b.txt', 1, 5),
      files.read('m/a.txt'),
      files.list('m/a.txt'),
    ]).toEqual([
      [
        { name: 'own.txt', directory: false },
        { name: 'm', directory: true },
      ],
      undefined,
      encode('bb'),
      1,
      undefined,
      [
        { name: 'b.txt', directory: false },
        { name: 'e', directory: true },
      ],
      encode('b'),
      encode('a'),
      undefined,
    ])
    expect(log).toEqual(['list ', 'list d', 'read d/b.txt', 'read a.txt'])
  })

  it('keeps what is written to the files of sources in memory, and their bytes as they were', () => {
    const { source, kept } = logged({ 'a.txt': 'abc', 'b.txt': 'b', 'd/c.txt': 'c' })
    const files = new MemoryFileSystem()
    files.mount('m', source)
    // Parts are copies, though the slice of Node's Buffers gives views.
    files.readAt('m/b.txt', 0, 1)![0] = 0x21
    const steps = [
      files.writeAt('m/a.txt', 1, encode('X')),
      files.write('m/d/new.txt', encode('n')),
      files.remove('m/d/c.txt'),
      files.resize('m/b.txt', 2),
    ]
    files.makeDirectory('m/d/f')
    expect([
      steps,
      files.read('m/a.txt'),
      files.read('m/b.txt'),
      files.list('m/d'),
      files.read('m/d/c.txt'),
      Array.from(kept, ([path, bytes]) => `${path} ${new TextDecoder().decode(bytes)}`),
    ]).toEqual([
      [true, true, true, true],
      encode('aXc'),
      encode('b\0'),
      [
        { name: 'new.txt', directory: false },
        { name: 'f', directory: true },
      ],
      undefined,
      ['b.txt b', 'a.txt abc'],
    ])
  })

  it('writes over the files of sources without reading them', () => {
    const { source, log } = logged({ 'a.txt': 'a', 'd/b.txt': 'b' })
    const files = new MemoryFileSystem()
    files.mount('m', source)
    expect([
      files.write('m/a.txt', encode('new')),
      files.write('m/d', encode('x')),
      files.read('m/a.txt'),
      files.list('m'),
    ]).toEqual([
      true,
      false,
      encode('new'),
      [
        { name: 'a.txt', directory: false },
        { name: 'd', directory: true },
      ],
    ])
    expect(log).toEqual(['list '])
  })

  it('moves the directories and files of sources, which take what they have from where they were', () => {
    const { source, log } = logged({ 'a.txt': 'a', 'd/e/c.txt': 'c' })
    const files = new MemoryFileSystem()
    files.mount('m', source)
    expect(files.rename('m/d', 'x')).toBe(true)
    expect(log).toEqual(['list '])
    expect(files.rename('m/a.txt', 'x/a.txt')).toBe(true)
    expect(files.rename('x', 'x/e/inside')).toBe(false)
    expect([
      files.list('m'),
      files.list('x'),
      files.read('x/e/c.txt'),
      files.read('x/a.txt'),
      files.list('m/d'),
    ]).toEqual([
      [],
      [
        { name: 'e', directory: true },
        { name: 'a.txt', directory: false },
      ],
      encode('c'),
      encode('a'),
      undefined,
    ])
    expect(log).toEqual(['list ', 'list d', 'list d/e', 'read d/e/c.txt', 'read a.txt'])
  })

  it('mounts sources at roots too, but only where there is nothing', () => {
    const { source } = logged({ 'a.txt': 'a' })
    const files = new MemoryFileSystem({ 'd/x.txt': 'x', 'f.txt': '' })
    expect(() => files.mount('d', source)).toThrow(new Error('The directory at d is not empty'))
    expect(() => files.mount('f.txt', source)).toThrow(new Error('There is a file at f.txt'))
    files.mount('e/f', source)
    const rooted = new MemoryFileSystem()
    rooted.mount('', source)
    rooted.mount('/', source)
    expect([
      files.list('e'),
      files.read('e/f/a.txt'),
      rooted.list(''),
      rooted.read('a.txt'),
      rooted.read('/a.txt'),
    ]).toEqual([
      [{ name: 'f', directory: true }],
      encode('a'),
      [{ name: 'a.txt', directory: false }],
      encode('a'),
      encode('a'),
    ])
  })
})

describe('addFile', () => {
  it('adds files with the directories their paths name, but not over directories', () => {
    const files = new MemoryFileSystem()
    addFile(files, 'a/b/c.txt', 'c')
    addFile(files, 'a/d.bin', new Uint8Array([1]))
    expect(files.list('a')).toEqual([
      { name: 'b', directory: true },
      { name: 'd.bin', directory: false },
    ])
    expect(files.read('a/b/c.txt')).toEqual(encode('c'))
    expect(() => addFile(files, 'a/b', 'x')).toThrow(new Error('There is a directory at a/b'))
  })
})

describe('parentOf', () => {
  it('names the directory that a path is in', () => {
    expect(parentOf('a/b/c')).toBe('a/b')
    expect(parentOf('a')).toBe('')
    expect(parentOf('/a')).toBe('/')
    expect(parentOf('C:/a')).toBe('C:')
    expect(parentOf('C:')).toBe('')
  })
})
