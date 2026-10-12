import { describe, expect, it } from 'vitest'

import { tokenize } from '../../src/core/console/tokenize.ts'

describe('tokenize', () => {
  it('splits lines at whitespace, control characters included', () => {
    expect(tokenize('say hello world')).toEqual(['say', 'hello', 'world'])
    expect(tokenize('  a\x01b\tc \r\n d  ')).toEqual(['a', 'b', 'c', 'd'])
    expect(tokenize('')).toEqual([])
    expect(tokenize(' \t ')).toEqual([])
    expect(tokenize('a\x7fb')).toEqual(['a\x7fb'])
    expect(tokenize('a \xa0 b')).toEqual(['a', '\xa0', 'b'])
    expect(tokenize('x'.repeat(10_000))).toEqual(['x'.repeat(10_000)])
  })

  it('keeps quoted arguments whole, with \\" for quotes', () => {
    expect(tokenize('say "hello world" x')).toEqual(['say', 'hello world', 'x'])
    expect(tokenize('a "" b')).toEqual(['a', '', 'b'])
    expect(tokenize('a "b c')).toEqual(['a', 'b c'])
    expect(tokenize('a "b \\"c\\" d"')).toEqual(['a', 'b "c" d'])
    expect(tokenize('"a\\b"')).toEqual(['a\\b'])
    expect(tokenize('"a\\\\"')).toEqual(['a\\"'])
    expect(tokenize('"a\\"')).toEqual(['a"'])
    expect(tokenize('a"b"c')).toEqual(['a', 'b', 'c'])
    expect(tokenize('"a"b')).toEqual(['a', 'b'])
    expect(tokenize('"#a //b"')).toEqual(['#a //b'])
  })

  it('ends lines at comments where arguments could start', () => {
    expect(tokenize('a # b')).toEqual(['a'])
    expect(tokenize('a #')).toEqual(['a'])
    expect(tokenize('a\t#b')).toEqual(['a'])
    expect(tokenize('a\x01#b')).toEqual(['a'])
    expect(tokenize('"a"#b')).toEqual(['a'])
    expect(tokenize('a // b')).toEqual(['a'])
    expect(tokenize('"a"//b')).toEqual(['a'])
    expect(tokenize('a#b a//b')).toEqual(['a#b', 'a//b'])
    expect(tokenize('# a')).toEqual([])
    expect(tokenize('#a')).toEqual([])
    expect(tokenize('// a')).toEqual([])
    expect(tokenize('/* a */ b')).toEqual([])
    expect(tokenize('/')).toEqual(['/'])
    expect(tokenize('/a')).toEqual(['/a'])
    expect(tokenize('a /')).toEqual(['a', '/'])
    expect(tokenize('a /b')).toEqual(['a', '/b'])
  })

  it('skips only /* and the character after it between arguments', () => {
    expect(tokenize('a /* b */ c')).toEqual(['a', 'b', '*/', 'c'])
    expect(tokenize('a /*b*/ c')).toEqual(['a', '*/', 'c'])
    expect(tokenize('a /*xy')).toEqual(['a', 'y'])
    expect(tokenize('a /*')).toEqual(['a'])
    expect(tokenize('a /*x')).toEqual(['a'])
    expect(tokenize('a /*x#')).toEqual(['a'])
    expect(tokenize('a /*x/*yz')).toEqual(['a', 'z'])
    expect(tokenize(' /* a */ b')).toEqual(['a', '*/', 'b'])
  })

  it('keeps JSON arrays and objects whole', () => {
    expect(tokenize('set a {"b": "c d"} e')).toEqual(['set', 'a', '{"b": "c d"}', 'e'])
    expect(tokenize('[1, 2] x')).toEqual(['[1, 2]', 'x'])
    expect(tokenize('a [1]b')).toEqual(['a', '[1]', 'b'])
    expect(tokenize('a ["#", "//"] b')).toEqual(['a', '["#", "//"]', 'b'])
    expect(tokenize('a {b c}')).toEqual(['a', '{b', 'c}'])
    expect(tokenize('a b[1]')).toEqual(['a', 'b[1]'])
    expect(tokenize('a "[1]"')).toEqual(['a', '[1]'])
    // Code points read as bytes are no UTF-8, so this is no JSON.
    expect(tokenize('a ["é"]')).toEqual(['a', '[', 'é', ']'])
  })

  it('splits lines of bytes that MSVC decodes from UTF-8, and no others', () => {
    const bytes = (...values: number[]) => tokenize(new Uint8Array(values))
    expect(tokenize(new TextEncoder().encode('a é 😀'))).toEqual(['a', 'é', '😀'])
    expect(bytes(0x61, 0x00, 0x62)).toEqual(['a', 'b'])
    // Overlong sequences, those of surrogates, and of five and six bytes.
    expect(bytes(0xc1, 0x81)).toEqual(['A'])
    expect(bytes(0x61, 0xc0, 0xa0, 0x62)).toEqual(['a', 'b'])
    expect(bytes(0xed, 0xa0, 0x80)).toEqual([String.fromCharCode(0xd800)])
    expect(bytes(0xf8, 0x80, 0x80, 0x81, 0x81)).toEqual(['A'])
    expect(bytes(0x61, 0xfc, 0x80, 0x80, 0x80, 0x80, 0x80, 0x62)).toEqual(['a', 'b'])
    expect(bytes(0xf4, 0x8f, 0xbf, 0xbf)).toEqual([String.fromCodePoint(0x10ffff)])
    for (const invalid of [
      [0x61, 0x80],
      [0xbf],
      [0x9f, 0xbf],
      [0xc3, 0xc3],
      [0x61, 0xfe, 0x80, 0x80, 0x80, 0x80, 0x81, 0x62],
      [0xc3],
      [0xe2, 0x82],
      [0xc3, 0x41],
      [0xe2, 0x28, 0xa1],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf7, 0xbf, 0xbf, 0xbf],
      [0xfd, 0x80, 0x80, 0x80, 0x80, 0x80],
      [0x61, 0x20, 0xff],
    ]) {
      expect(bytes(...invalid), String(invalid)).toEqual([])
    }
  })
})
