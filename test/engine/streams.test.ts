import { describe, expect, it } from 'vitest'

import { MemoryFileSystem } from '../../src/core/engine/files.ts'
import { OpenFiles } from '../../src/core/engine/streams.ts'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

function openFiles(files: Record<string, string> = { 'a.txt': 'hello', 'dir/x.txt': 'x' }) {
  const memory = new MemoryFileSystem(files)
  return { memory, open: new OpenFiles(memory) }
}

describe('OpenFiles', () => {
  it('open files that are there, at positions of their own over what all of them see', () => {
    const { memory, open } = openFiles()
    const reader = open.openExisting('a.txt', 'read')!
    const writer = open.openExisting('a.txt', 'write')!
    const read = decode(reader.read(2))
    writer.seek(3n, 'set')
    writer.write(encode('P'))
    expect([
      read,
      reader.position,
      decode(reader.read(10)),
      reader.position,
      writer.position,
      decode(memory.read('a.txt')),
      reader.length(),
      open.openExisting('none.txt', 'read'),
      open.openExisting('dir', 'read'),
    ]).toEqual(['he', 2, 'lPo', 5, 4, 'helPo', 5, undefined, undefined])
  })

  it('write past zeros after the end, only at the end to append, and nothing to read', () => {
    const { memory, open } = openFiles()
    const writer = open.openExisting('a.txt', 'write')!
    const appender = open.openExisting('a.txt', 'append')!
    const reader = open.openExisting('a.txt', 'read')!
    writer.seek(7n, 'set')
    const steps = [
      writer.write(encode('!')),
      writer.position,
      decode(appender.read(1)),
      appender.write(encode('?')),
      appender.position,
      reader.write(encode('x')),
      reader.position,
      writer.write(new Uint8Array()),
    ]
    expect([steps, decode(memory.read('a.txt'))]).toEqual([
      [true, 8, 'h', true, 9, false, 0, true],
      'hello\0\0!?',
    ])
  })

  it('seek as SetFilePointer does, by 32 bits and nowhere before the start', () => {
    const { open } = openFiles()
    const handle = open.openExisting('a.txt', 'read')!
    const positions = [
      handle.seek(-1n, 'set'),
      handle.position,
      handle.seek(2n, 'set'),
      handle.seek(-1n, 'cur'),
      handle.seek(0n, 'end'),
      handle.seek(-2n, 'end'),
      handle.seek(2n ** 32n + 1n, 'set'),
      handle.seek(2n ** 31n - 1n, 'set'),
      handle.seek(2n ** 31n - 1n, 'cur'),
      handle.seek(1n, 'cur'),
      handle.position,
      handle.seek(-(2n ** 32n) + 2n, 'cur'),
    ]
    expect(positions).toEqual([
      0xffff_ffff,
      0,
      2,
      1,
      5,
      3,
      1,
      2 ** 31 - 1,
      0xffff_fffe,
      0xffff_ffff,
      0xffff_fffe,
      // The low 32 bits of -2^32 + 2 are 2.
      0xffff_ffff,
    ])
  })

  it('truncate files for handles that write anywhere, and move the position either way', () => {
    const { memory, open } = openFiles()
    const writer = open.openExisting('a.txt', 'write')!
    const appender = open.openExisting('a.txt', 'append')!
    const reader = open.openExisting('a.txt', 'read')!
    const results = [
      appender.truncate(1),
      appender.position,
      reader.truncate(0),
      decode(memory.read('a.txt')),
      writer.truncate(2),
      writer.position,
      decode(memory.read('a.txt')),
      writer.truncate(4),
    ]
    expect([results, memory.read('a.txt')]).toEqual([
      [false, 1, false, 'hello', true, 2, 'he', true],
      encode('he\0\0'),
    ])
  })

  it('flush files for handles that write', () => {
    const { open } = openFiles()
    expect(
      (['write', 'append', 'read'] as const).map((access) =>
        open.openExisting('a.txt', access)!.flush(),
      ),
    ).toEqual([true, true, false])
  })

  it('create files where nothing is, whose handles share no writes until they close', () => {
    const { memory, open } = openFiles()
    const creator = open.createNew('new.txt', 'write')!
    const steps = [
      memory.read('new.txt'),
      open.createNew('new.txt', 'write'),
      open.createNew('a.txt', 'append'),
      open.createNew('dir', 'write'),
      open.createNew('missing/x.txt', 'write'),
      open.openExisting('new.txt', 'read') !== undefined,
      open.openExisting('new.txt', 'write'),
      open.openExisting('new.txt', 'append'),
    ]
    creator.write(encode('made'))
    creator.close()
    creator.close()
    const writer = open.openExisting('new.txt', 'write')!
    expect([steps, writer.access, decode(writer.read(4))]).toEqual([
      [new Uint8Array(), undefined, undefined, undefined, undefined, true, undefined, undefined],
      'write',
      'made',
    ])
  })

  it('keep files in use while handles have them open, and the directories they are in', () => {
    const { open } = openFiles()
    const file = open.openExisting('a.txt', 'read')!
    const other = open.openExisting('a.txt', 'read')!
    const inner = open.openExisting('dir/x.txt', 'read')!
    const before = ['a.txt', 'dir', 'di', 'dir/x', ''].map((path) => open.inUse(path))
    file.close()
    const one = open.inUse('a.txt')
    other.close()
    inner.close()
    const closed = [open.inUse('a.txt'), open.inUse('dir')]
    // A handle closed again leaves those that opened the file since as they are.
    const reopened = open.openExisting('a.txt', 'read')!
    file.close()
    expect([before, one, closed, open.inUse('a.txt'), reopened.position]).toEqual([
      [true, true, false, false, false],
      true,
      [false, false],
      true,
      0,
    ])
  })

  it('read and write nothing once the host took their file away', () => {
    const { memory, open } = openFiles()
    const handle = open.openExisting('a.txt', 'write')!
    handle.seek(2n, 'set')
    memory.remove('a.txt')
    expect([
      handle.length(),
      handle.read(1),
      handle.write(encode('x')),
      handle.position,
      memory.read('a.txt'),
    ]).toEqual([0, new Uint8Array(), false, 2, undefined])
  })
})
