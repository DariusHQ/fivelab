import { describe, expect, it } from 'vitest'

import { jsonLength } from '../../src/core/console/json.ts'

/** The length of the JSON at the start of `text`, read as code points. */
function length(text: string): number | undefined {
  return jsonLength(
    Array.from(text, (char) => char.codePointAt(0)!),
    0,
  )
}

/** The length of the JSON at the start of `text`, read as UTF-8 bytes. */
function byteLength(text: string | readonly number[]): number | undefined {
  return jsonLength(typeof text === 'string' ? new TextEncoder().encode(text) : text, 0)
}

describe('jsonLength', () => {
  it('measures the array or object at the start, whatever follows it', () => {
    expect(length('[]')).toBe(2)
    expect(length('{}')).toBe(2)
    expect(length('{"a": 1, "b": 2}')).toBe(16)
    expect(length('[1, "a", true, false, null] rest')).toBe(27)
    expect(length('{"a": {"b": [1, {}]}, "c": []};x')).toBe(30)
    expect(length('[ \t\n\r1 \t\n\r]')).toBe(11)
    expect(length('[1]]')).toBe(3)
    expect(length('[1]// a')).toBe(3)
    expect(
      jsonLength(
        Array.from('ab[1]', (char) => char.charCodeAt(0)),
        2,
      ),
    ).toBe(3)
  })

  it('takes no values but arrays and objects', () => {
    for (const text of ['1', '"a"', 'true', 'null', ' []', '']) {
      expect(length(text), text).toBe(undefined)
    }
  })

  it('takes what nlohmann parses, without comments', () => {
    for (const text of [
      '[',
      '[1',
      '[1,]',
      '[,1]',
      '[1 2]',
      '{"a"}',
      '{"a":}',
      '{"a" 1}',
      '{"a",1}',
      '{1:2}',
      '{"a":1,}',
      '{"a":1,2:3}',
      '{"a":1,"b"2}',
      '{"a":1,"b",2}',
      "['a']",
      '[tru]',
      '[trUe]',
      '[falsy]',
      '[True]',
      '[nul]',
      '[/* a */ 1]',
      '[\f1]',
      '[\v1]',
      '[\xa01]',
      '[1\u0000]',
    ]) {
      expect(length(text), text).toBe(undefined)
    }
  })

  it('reads numbers as JSON writes them, which must fit in doubles', () => {
    for (const number of ['0', '-0', '12', '-12', '1.5', '0.25e-3', '1E5', '1e+5', '1e40']) {
      expect(length(`[${number}]`), number).toBe(number.length + 2)
    }
    for (const number of [
      '01',
      '-',
      '-a',
      '1.',
      '.5',
      '1e',
      '1e+',
      '+1',
      '0x1',
      '1e400',
      '-1e400',
    ]) {
      expect(length(`[${number}]`), number).toBe(undefined)
    }
    // Integers too large for 64 bits are read as doubles.
    expect(length(`[${'9'.repeat(308)}]`)).toBe(310)
    expect(length(`[${'9'.repeat(309)}]`)).toBe(undefined)
  })

  it('reads strings with the escapes of JSON, and no control characters', () => {
    const u = (hex: string) => `\\u${hex}`
    expect(length(`["\\"\\\\\\/\\b\\f\\n\\r\\t${u('00e9')}${u('D83D')}${u('de00')}"]`)).toBe(38)
    for (const text of [
      '["\\a"]',
      `["${u('00e')}"]`,
      `["${u('00eg')}"]`,
      `["${u('D83D')}"]`,
      `["${u('D83D')}x"]`,
      `["${u('D83D')}xxdc00"]`,
      `["${u('D83D')}${u('0041')}"]`,
      `["${u('DE00')}"]`,
      '["\t"]',
      '["\u0000"]',
      '["\u001f"]',
      '["a]',
      '["a\\',
    ]) {
      expect(length(text), text).toBe(undefined)
    }
    expect(length('["\u007f"]')).toBe(5)
  })

  it('reads strings of bytes as UTF-8', () => {
    expect(byteLength('["é€😀"]')).toBe(13)
    for (const bytes of [
      [0x80],
      [0xc1, 0xbf],
      [0xc2],
      [0xc2, 0x41],
      [0xe0, 0x9f, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf0, 0x8f, 0x80, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xff],
    ]) {
      expect(byteLength([0x5b, 0x22, ...bytes, 0x22, 0x5d]), String(bytes)).toBe(undefined)
    }
    expect(byteLength([0x5b, 0x22, 0xed, 0x9f, 0xbf, 0xf4, 0x8f, 0xbf, 0xbf, 0x22, 0x5d])).toBe(11)
  })

  it('reads code points as bytes, so takes only those that spell UTF-8', () => {
    expect(length('["é"]')).toBe(undefined)
    expect(length('["€"]')).toBe(undefined)
    expect(length('["\u{10030}"]')).toBe(undefined)
    // U+10030 is no hex digit, though its low 16 bits are.
    expect(length('["\\u\u{10030}000"]')).toBe(undefined)
    // U+00C3 U+00A9 spell the UTF-8 of é.
    expect(length('["\xc3\xa9"]')).toBe(6)
  })

  it('reads deeply nested values', () => {
    expect(length('['.repeat(100_000) + ']'.repeat(100_000))).toBe(200_000)
  })
})
