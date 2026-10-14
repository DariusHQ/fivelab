import { describe, expect, it } from 'vitest'

import type { MsgpackObject } from '../../src/core/engine/msgpack.ts'
import { msgpackOfJson } from '../../src/core/engine/rapidjson.ts'

const encoder = new TextEncoder()

/** The msgpack value of JSON, with strings as text and maps as lists of their entries, or undefined. */
function read(json: string | Uint8Array): unknown {
  const object = msgpackOfJson(typeof json === 'string' ? encoder.encode(json) : json)
  return object === undefined ? undefined : shown(object)
}

function shown(object: MsgpackObject): unknown {
  switch (object.type) {
    case 'nil':
      return null
    case 'str':
    case 'bin':
      return Array.from(object.bytes)
    case 'array':
      return object.items.map(shown)
    case 'map':
      return object.entries.map(([key, value]) => [shown(key), shown(value)])
    case 'ext':
      return object.extension
    default:
      return `${object.type} ${String(object.value)}`
  }
}

const bytes = (text: string) => Array.from(encoder.encode(text))

/** The JSON escape of a UTF-16 code unit, which the source spells apart from its digits. */
const u = (hex: string) => `${'\\'}u${hex}`

describe('JSON read as RapidJSON reads it', () => {
  it('has any value alone, with whitespace around it', () => {
    expect(['null', ' true\n', '\tfalse\r', '"a"', '[]', '{}'].map(read)).toEqual([
      null,
      'boolean true',
      'boolean false',
      bytes('a'),
      [],
      [],
    ])
  })

  it('fails without a value, with more than one, or with words that are not literals', () => {
    for (const json of [
      '',
      ' \n',
      'nul',
      'nulls',
      'tru',
      'True',
      'falsey',
      '1 2',
      '{} x',
      '\u000b1',
    ]) {
      expect(read(json)).toBeUndefined()
    }
  })

  it('ends at a NUL, as C strings do', () => {
    expect(read(new Uint8Array([0x31, 0x00, 0x78]))).toBe('positive 1')
    expect(read(new Uint8Array([0x00, 0x31]))).toBeUndefined()
  })

  it('has integers for numbers with no fraction or exponent that fit 64 bits, of their sign', () => {
    const numbers = [
      '0',
      '-0',
      '7',
      '-7',
      '4294967295',
      '4294967296',
      '-2147483648',
      '-2147483649',
      '18446744073709551615',
      '-9223372036854775808',
    ]
    expect(numbers.map(read)).toEqual([
      'positive 0',
      'positive 0',
      'positive 7',
      'negative -7',
      'positive 4294967295',
      'positive 4294967296',
      'negative -2147483648',
      'negative -2147483649',
      'positive 18446744073709551615',
      'negative -9223372036854775808',
    ])
  })

  it('has doubles for the other numbers, which it scales by powers of 10 as they are', () => {
    const numbers = [
      '18446744073709551616',
      '-9223372036854775809',
      '1.0',
      '-1.5',
      '1e2',
      '1e+2',
      '1E-2',
      '1e-310',
      '0.6e-244',
      '6e-245',
      '1.7976931348623157e308',
      '1e-400',
      '1e-99999999999',
      '-0.0',
    ]
    expect(numbers.map(read)).toEqual([
      'float64 18446744073709552000',
      'float64 -9223372036854776000',
      'float64 1',
      'float64 -1.5',
      'float64 100',
      'float64 100',
      'float64 0.01',
      // RapidJSON divides by 1e308 first, then by the rest.
      'float64 1e-310',
      // RapidJSON divides 6 by 1e245, where 6e-245 is the nearest double.
      'float64 5.9999999999999996e-245',
      'float64 5.9999999999999996e-245',
      'float64 1.7976931348623157e+308',
      'float64 0',
      'float64 0',
      'float64 0',
    ])
    expect(Object.is((msgpackOfJson(encoder.encode('-0.0')) as { value: number }).value, -0)).toBe(
      true,
    )
  })

  it('keeps 17 significant digits of fractions, and reads the rest of them without them', () => {
    // RapidJSON divides the double nearest 12345678901234567 by 1e20, where the nearest double ends in 68.
    expect(read('0.000123456789012345678901')).toBe('float64 0.00012345678901234567')
    // RapidJSON goes on from the double nearest the first 20 digits, which fit 64 bits, by 10.
    expect(read('123456789012345678901.5')).toBe('float64 123456789012345670000')
    expect(read('1.00000000000000000009e1')).toBe('float64 10')
    // The 17th digit counts, which takes RapidJSON to the double after 1, where 1 is the nearest.
    expect(read('1.00000000000000009')).toBe('float64 1.0000000000000002')
    // Digits go in the 64-bit significand while it is below 2 to the power of 53.
    expect(read('9007199254740991.5')).toBe('float64 9007199254740992')
    // Leading zeros of fractions are not significant, and the digits after the 17th are dropped.
    expect(read('0.0091868066446644688')).toBe('float64 0.009186806644664466')
    expect(read('0.090840682044822006644')).toBe('float64 0.090840682044822')
  })

  it('fails for numbers that are not, or too large for a double', () => {
    for (const json of [
      '-',
      '+1',
      '.5',
      '01',
      '1.',
      '1.e1',
      '1e',
      '1e+',
      '-a',
      '1e309',
      '2e308',
      '0.1e310x',
    ]) {
      expect(read(json)).toBeUndefined()
    }
    expect([read('1e308'), read('0.001e310')]).toEqual(['float64 1e+308', 'float64 1e+307'])
  })

  it('has the bytes of strings, with their escapes, and unpaired low surrogates as they are', () => {
    const strings = [
      String.raw`"\"\\\/\b\f\n\r\t"`,
      `"${u('0041')}${u('00e9')}${u('20AC')}"`,
      `"${u('007f')}${u('0080')}${u('07ff')}${u('0800')}${u('ffff')}"`,
      `"${u('D83D')}${u('DE00')}"`,
      `"${u('DC00')}"`,
      `"a${u('0000')}b"`,
    ]
    expect(strings.map(read)).toEqual([
      [0x22, 0x5c, 0x2f, 0x08, 0x0c, 0x0a, 0x0d, 0x09],
      [0x41, 0xc3, 0xa9, 0xe2, 0x82, 0xac],
      [0x7f, 0xc2, 0x80, 0xdf, 0xbf, 0xe0, 0xa0, 0x80, 0xef, 0xbf, 0xbf],
      [0xf0, 0x9f, 0x98, 0x80],
      [0xed, 0xb0, 0x80],
      [0x61, 0x00, 0x62],
    ])
    // Bytes that are no UTF-8 stay as they are.
    expect(read(new Uint8Array([0x22, 0xff, 0x80, 0x22]))).toEqual([0xff, 0x80])
  })

  it('fails for strings with bad escapes, unpaired high surrogates, control characters or no end', () => {
    const strings = [
      String.raw`"\x"`,
      `"${u('12G4')}"`,
      `"${u('123')}"`,
      `"${u('D800')}"`,
      `"${u('D800')}x"`,
      `"${u('D800')}uDC00"`,
      `"${u('D800')}${u('0041')}"`,
      `"${u('D800')}${u('E000')}"`,
      '"a\tb"',
      `"${String.fromCharCode(0x1f)}"`,
      '"abc',
      '"\\',
    ]
    for (const json of strings) expect(read(json)).toBeUndefined()
  })

  it('has arrays of their values, and fails for arrays that do not end as they should', () => {
    expect(read('[ 1 , [ "a" ] , {} ]')).toEqual(['positive 1', [bytes('a')], []])
    for (const json of ['[', '[1', '[1,]', '[1 2]', '[,1]', '[1,,2]']) {
      expect(read(json)).toBeUndefined()
    }
  })

  it('has maps of objects, ordered by the bytes of the names, which end at a NUL, with the first of each', () => {
    const json = `{ "b" : 1 , "a${u('0000')}z" : 2 , "a" : 3 , "${u('00e9')}" : 4 , "B" : 5 , "b" : 6 }`
    expect(read(json)).toEqual([
      [bytes('B'), 'positive 5'],
      [bytes('a'), 'positive 2'],
      [bytes('b'), 'positive 1'],
      [bytes('é'), 'positive 4'],
    ])
    for (const json of [
      '{',
      '{"a"}',
      '{"a":}',
      '{"a":1',
      '{"a":1,}',
      '{"a" 1}',
      '{1:2}',
      '{"a":1 "b":2}',
      '{a":1}',
    ]) {
      expect(read(json)).toBeUndefined()
    }
  })
})
