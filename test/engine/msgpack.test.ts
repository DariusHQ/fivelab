import { describe, expect, it } from 'vitest'

import {
  arrayLength,
  Extension,
  pack,
  stringOf,
  toJson,
  unpackObject,
  type PackedValue,
} from '../../src/core/engine/msgpack.ts'
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

describe('Extensions', () => {
  const extension = (size: number) => new Extension(11, new Uint8Array(size).fill(7))

  it('pack in fixext for the sizes that have one, as msgpack-c packs them', () => {
    expect([1, 2, 4, 8, 16].map((size) => head(extension(size), 2))).toEqual([
      'd4 0b',
      'd5 0b',
      'd6 0b',
      'd7 0b',
      'd8 0b',
    ])
  })

  it('pack in ext 8, 16 and 32 for the others', () => {
    expect(head(extension(0), 3)).toBe('c7 00 0b')
    expect(head(extension(3), 4)).toBe('c7 03 0b 07')
    expect(head(extension(255), 3)).toBe('c7 ff 0b')
    expect(head(extension(256), 4)).toBe('c8 01 00 0b')
    expect(head(extension(65536), 6)).toBe('c9 00 01 00 00 0b')
    expect(head(new Extension(-1, new Uint8Array(1)), 2)).toBe('d4 ff')
  })
})

/** Bytes from hex. */
function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.split(' '), (byte) => parseInt(byte, 16))
}

describe('unpackObject', () => {
  it('unpacks what pack packs, with the types of msgpack-c', () => {
    expect(
      unpackObject(pack([null, true, 1, -1, 2.5, 'a', new Uint8Array([2]), { k: [] }])),
    ).toEqual({
      type: 'array',
      items: [
        { type: 'nil' },
        { type: 'boolean', value: true },
        { type: 'positive', value: 1n },
        { type: 'negative', value: -1n },
        { type: 'float64', value: 2.5 },
        { type: 'str', bytes: new Uint8Array([97]) },
        { type: 'bin', bytes: new Uint8Array([2]) },
        {
          type: 'map',
          entries: [
            [
              { type: 'str', bytes: new Uint8Array([107]) },
              { type: 'array', items: [] },
            ],
          ],
        },
      ],
    })
  })

  it('takes integers that are not negative as positive, whichever format holds them', () => {
    const cases: [string, bigint][] = [
      ['00', 0n],
      ['7f', 127n],
      ['e0', -32n],
      ['cc ff', 255n],
      ['cd ff ff', 65535n],
      ['ce ff ff ff ff', 4294967295n],
      ['cf ff ff ff ff ff ff ff ff', 18446744073709551615n],
      ['d0 05', 5n],
      ['d0 80', -128n],
      ['d1 80 00', -32768n],
      ['d2 80 00 00 00', -2147483648n],
      ['d3 80 00 00 00 00 00 00 00', -(2n ** 63n)],
      ['d3 00 00 00 00 00 00 00 05', 5n],
    ]
    expect(
      cases.map(([hex]) => {
        const object = unpackObject(bytes(hex))
        return object.type === 'positive' || object.type === 'negative'
          ? [object.type, object.value]
          : object
      }),
    ).toEqual(cases.map(([, value]) => [value < 0n ? 'negative' : 'positive', value]))
  })

  it('unpacks fixmaps and fixarrays up to their 15 entries', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => i)
    const map = unpackObject(pack(Object.fromEntries(fifteen.map((i) => [`k${i}`, i]))))
    expect(map.type === 'map' && map.entries.length).toBe(15)
    const array = unpackObject(pack(fifteen))
    expect(array.type === 'array' && array.items.length).toBe(15)
  })

  it('keeps bytes of its own, whatever happens to those it unpacked', () => {
    const packed = pack('ab')
    const object = unpackObject(packed)
    packed[1] = 0
    expect(object).toEqual({ type: 'str', bytes: new Uint8Array([97, 98]) })
  })

  it('unpacks floats, strings, binaries, arrays and maps of each size', () => {
    expect(unpackObject(bytes('ca 3f c0 00 00'))).toEqual({ type: 'float32', value: 1.5 })
    expect(unpackObject(bytes('cb 3f f8 00 00 00 00 00 00'))).toEqual({
      type: 'float64',
      value: 1.5,
    })
    for (const hex of ['a1 61', 'd9 01 61', 'da 00 01 61', 'db 00 00 00 01 61']) {
      expect(unpackObject(bytes(hex))).toEqual({ type: 'str', bytes: new Uint8Array([97]) })
    }
    for (const hex of ['c4 01 61', 'c5 00 01 61', 'c6 00 00 00 01 61']) {
      expect(unpackObject(bytes(hex))).toEqual({ type: 'bin', bytes: new Uint8Array([97]) })
    }
    for (const hex of ['91 c0', 'dc 00 01 c0', 'dd 00 00 00 01 c0']) {
      expect(unpackObject(bytes(hex))).toEqual({ type: 'array', items: [{ type: 'nil' }] })
    }
    for (const hex of ['81 c0 c2', 'de 00 01 c0 c2', 'df 00 00 00 01 c0 c2']) {
      expect(unpackObject(bytes(hex))).toEqual({
        type: 'map',
        entries: [[{ type: 'nil' }, { type: 'boolean', value: false }]],
      })
    }
  })

  it('unpacks extensions of each size, with signed types', () => {
    const ext = (type: number, ...data: number[]) => ({
      type: 'ext',
      extension: new Extension(type, new Uint8Array(data)),
    })
    expect(unpackObject(bytes('d4 0a 01'))).toEqual(ext(10, 1))
    expect(unpackObject(bytes('d5 0b 01 02'))).toEqual(ext(11, 1, 2))
    expect(unpackObject(bytes('d6 ff 01 02 03 04'))).toEqual(ext(-1, 1, 2, 3, 4))
    expect(unpackObject(bytes('d7 01 00 00 00 00 00 00 00 00'))).toEqual(
      ext(1, 0, 0, 0, 0, 0, 0, 0, 0),
    )
    expect(unpackObject(new Uint8Array([0xd8, 1, ...new Array<number>(16).fill(9)]))).toEqual(
      ext(1, ...new Array<number>(16).fill(9)),
    )
    expect(unpackObject(bytes('c7 02 0a 01 02'))).toEqual(ext(10, 1, 2))
    expect(unpackObject(bytes('c8 00 01 0a 01'))).toEqual(ext(10, 1))
    expect(unpackObject(bytes('c9 00 00 00 01 0a 01'))).toEqual(ext(10, 1))
  })

  it('fails for bytes that hold no value', () => {
    expect(() => unpackObject(bytes('c1'))).toThrow(new Error('msgpack has no format 0xc1'))
    expect(() => unpackObject(new Uint8Array())).toThrow(
      new Error('msgpack ends before its value does'),
    )
    expect(() => unpackObject(bytes('a2 61'))).toThrow(
      new Error('msgpack ends before its value does'),
    )
    expect(() => unpackObject(bytes('92 c0'))).toThrow(
      new Error('msgpack ends before its value does'),
    )
  })
})

describe('stringOf', () => {
  it('converts strings and binaries, and no other values, as msgpack-c does', () => {
    expect(stringOf(unpackObject(pack('é')))).toBe('é')
    expect(stringOf(unpackObject(pack(new Uint8Array([104, 105]))))).toBe('hi')
    expect(stringOf(unpackObject(pack(1)))).toBe(undefined)
    expect(stringOf(unpackObject(pack(null)))).toBe(undefined)
  })
})

describe('toJson', () => {
  const json = (value: PackedValue) => toJson(unpackObject(pack(value)))

  it('writes values as RapidJSON writes them', () => {
    expect(json([null, true, false, 0, -5, 2 ** 53, 'a', new Uint8Array([98])])).toBe(
      '[null,true,false,0,-5,9007199254740992,"a","b"]',
    )
    expect(toJson(unpackObject(bytes('cf ff ff ff ff ff ff ff ff')))).toBe('18446744073709551615')
    expect(json(new Extension(10, new Uint8Array(1)))).toBe('null')
  })

  it('writes doubles with .0 for integers and e for exponents, but not those that are not finite', () => {
    expect([2.5, 0.1, 1e21, 1.5e22, 1e-7, 0.000001, -0].map(json)).toEqual([
      '2.5',
      '0.1',
      '1e21',
      '1.5e22',
      '1e-7',
      '0.000001',
      '-0.0',
    ])
    // Integers that pack as doubles, as Lua's floats do.
    expect(toJson(unpackObject(bytes('cb 40 00 00 00 00 00 00 00')))).toBe('2.0')
    expect(toJson(unpackObject(bytes('ca 3f c0 00 00')))).toBe('1.5')
    expect([NaN, Infinity, [1, -Infinity], { a: NaN }].map(json)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('escapes quotes, backslashes and control characters', () => {
    expect(json('a"b\\c\b\f\n\r\t\u0001\u001f \u007f/é')).toBe(
      '"a\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001F \u007f/é"',
    )
  })

  it('orders the members of maps by the bytes of their keys, as strings or as integers', () => {
    expect(json({ b: 1, a: { d: [], c: 2 }, B: 3 })).toBe('{"B":3,"a":{"c":2,"d":[]},"b":1}')
    expect(json([10, 2, 1])).toBe('[10,2,1]')
    // An integer key first makes all keys integers, which FiveM orders as strings.
    expect(toJson(unpackObject(bytes('83 0a c0 02 c2 ff c3')))).toBe(
      '{"-1":true,"10":null,"2":false}',
    )
    expect(toJson(unpackObject(bytes('82 a1 61 01 a1 61 02')))).toBe('{"a":2}')
    expect(toJson(unpackObject(bytes('81 ff c3')))).toBe('{"-1":true}')
    expect(toJson(unpackObject(bytes('82 ce 7f ff ff ff 01 d2 80 00 00 00 02')))).toBe(
      '{"-2147483648":2,"2147483647":1}',
    )
    expect(json({})).toBe('{}')
  })

  it('fails for maps with keys that do not convert to the type of their first', () => {
    expect(() => toJson(unpackObject(bytes('82 a1 61 01 01 02')))).toThrow(TypeError)
    expect(() => toJson(unpackObject(bytes('82 01 01 a1 61 02')))).toThrow(TypeError)
    expect(() => toJson(unpackObject(bytes('81 c0 01')))).toThrow(TypeError)
    // Only str keys first make a map of strings, and FiveM converts the others to ints.
    expect(() => toJson(unpackObject(bytes('81 c4 01 61 01')))).toThrow(TypeError)
    expect(() => toJson(unpackObject(bytes('81 ce 80 00 00 00 01')))).toThrow(TypeError)
    expect(() => toJson(unpackObject(bytes('81 d3 ff ff ff ff 7f ff ff ff 01')))).toThrow(TypeError)
  })
})
