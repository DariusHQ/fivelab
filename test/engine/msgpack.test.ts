import { describe, expect, it } from 'vitest'

import { arrayLength, pack, type PackedValue } from '../../src/core/engine/msgpack.ts'
import { createProcess } from './helpers.ts'

/** The first `count` bytes of the packed value, in hex. */
function head(value: PackedValue, count = Infinity): string {
  return Array.from(pack(value).subarray(0, count), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join(' ')
}

describe('arrayLength', () => {
  it('reads the length of the array msgpack bytes start with', () => {
    expect(arrayLength(pack([]))).toBe(0)
    expect(arrayLength(pack([1, [2, 3]]))).toBe(2)
    expect(arrayLength(pack(new Array<null>(16).fill(null)))).toBe(16)
    expect(arrayLength(new Uint8Array([0xdd, 0, 1, 0, 0]))).toBe(65536)
  })

  it('reads 0 for bytes that start with no array', () => {
    expect(arrayLength(pack({ a: [1] }))).toBe(0)
    expect(arrayLength(pack(null))).toBe(0)
    expect(arrayLength(new Uint8Array())).toBe(0)
    expect(arrayLength(new Uint8Array([0xdc, 0]))).toBe(0)
  })
})

describe('pack', () => {
  it('packs nil and booleans', () => {
    expect([null, false, true].map((value) => head(value))).toEqual(['c0', 'c2', 'c3'])
  })

  it('packs integers in the smallest format that holds them, positive ones unsigned', () => {
    const cases: [number, string][] = [
      [0, '00'],
      [127, '7f'],
      [128, 'cc 80'],
      [255, 'cc ff'],
      [256, 'cd 01 00'],
      [65535, 'cd ff ff'],
      [65536, 'ce 00 01 00 00'],
      [2 ** 32 - 1, 'ce ff ff ff ff'],
      [2 ** 32, 'cf 00 00 00 01 00 00 00 00'],
      [-1, 'ff'],
      [-32, 'e0'],
      [-33, 'd0 df'],
      [-128, 'd0 80'],
      [-129, 'd1 ff 7f'],
      [-32768, 'd1 80 00'],
      [-32769, 'd2 ff ff 7f ff'],
      [-(2 ** 31), 'd2 80 00 00 00'],
      [-(2 ** 31) - 1, 'd3 ff ff ff ff 7f ff ff ff'],
      [-(2 ** 63), 'd3 80 00 00 00 00 00 00 00'],
    ]
    expect(cases.map(([value]) => [value, head(value)])).toEqual(cases)
  })

  it('packs other numbers as doubles', () => {
    const cases: [number, string][] = [
      [0.5, 'cb 3f e0 00 00 00 00 00 00'],
      [-0, 'cb 80 00 00 00 00 00 00 00'],
      [Infinity, 'cb 7f f0 00 00 00 00 00 00'],
      [2 ** 64, 'cb 43 f0 00 00 00 00 00 00'],
      [-(2 ** 63) - 2048, 'cb c3 e0 00 00 00 00 00 01'],
    ]
    expect(cases.map(([value]) => [value, head(value)])).toEqual(cases)
  })

  it('packs strings as UTF-8, in the smallest format that holds them', () => {
    expect(head('')).toBe('a0')
    expect(head('é')).toBe('a2 c3 a9')
    const cases: [number, string][] = [
      [31, 'bf'],
      [32, 'd9 20'],
      [255, 'd9 ff'],
      [256, 'da 01 00'],
      [65535, 'da ff ff'],
      [65536, 'db 00 01 00 00'],
    ]
    expect(
      cases.map(([length, bytes]) => [length, head('x'.repeat(length), bytes.split(' ').length)]),
    ).toEqual(cases)
    expect(pack('x'.repeat(65536)).length).toBe(65541)
  })

  it('packs bytes as binaries', () => {
    expect(head(new Uint8Array([1, 2]))).toBe('c4 02 01 02')
    expect(head(new Uint8Array(256), 3)).toBe('c5 01 00')
    expect(head(new Uint8Array(65536), 5)).toBe('c6 00 01 00 00')
  })

  it('packs arrays and objects, with their keys as strings', () => {
    expect(head([])).toBe('90')
    expect(head([1, 'a'])).toBe('92 01 a1 61')
    expect(head(Array(15).fill(0), 1)).toBe('9f')
    expect(head(Array(16).fill(0), 3)).toBe('dc 00 10')
    expect(head(Array(65536).fill(0), 5)).toBe('dd 00 01 00 00')
    expect(head({})).toBe('80')
    expect(head({ a: [true] })).toBe('81 a1 61 91 c3')
    const keys = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [i, 0]))
    expect(head(keys(15), 1)).toBe('8f')
    expect(head(keys(16), 3)).toBe('de 00 10')
    expect(head(keys(65536), 5)).toBe('df 00 01 00 00')
  })

  it('gives Lua scripts the values it packs', async () => {
    const proc = await createProcess()
    proc
      .add('a', {
        'main.lua': `AddEventHandler('values', function(...)
    for i = 1, select('#', ...) do
        local value = select(i, ...)
        print(type(value), math.type(value), type(value) == 'table' and json.encode(value) or value)
    end
end)`,
      })
      .start()
    proc.take()
    proc.manager.events.trigger(
      'values',
      pack([
        1,
        2.5,
        -(2 ** 40),
        'é',
        true,
        false,
        [1, 2],
        { key: 'value' },
        new Uint8Array([104, 105]),
      ]),
    )
    expect(proc.take()).toEqual([
      '[script:a] number\tinteger\t1',
      '[script:a] number\tfloat\t2.5',
      '[script:a] number\tinteger\t-1099511627776',
      '[script:a] string\tnil\té',
      '[script:a] boolean\tnil\ttrue',
      '[script:a] boolean\tnil\tfalse',
      '[script:a] table\tnil\t[1,2]',
      '[script:a] table\tnil\t{"key":"value"}',
      '[script:a] string\tnil\thi',
    ])
  })
})
