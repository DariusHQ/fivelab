import { describe, expect, it } from 'vitest'

import { stof, stoi, stoiError } from '../src/core/libc.ts'

describe('stoi', () => {
  it('reads the int at the start of text, after whitespace and a sign', () => {
    const read = ['42', '  -17abc', '+5', '\t\n\v\f\r 7', '00012', '0x10', '1e3', '-0']
    expect(read.map(stoi)).toEqual([42, -17, 5, 7, 12, 0, 1, 0])
  })

  it('reads nothing where there is no int, or one that does not fit in 32 bits', () => {
    const texts = [
      '',
      'abc',
      '- 1',
      '+-1',
      ' ',
      '2147483648',
      '-2147483649',
      '99999999999999999999',
    ]
    expect(texts.map(stoi)).toEqual(texts.map(() => undefined))
    expect([stoi('2147483647'), stoi('-2147483648')]).toEqual([2147483647, -2147483648])
  })

  it('throws, as MSVC says, when there is no int, or one that does not fit in 32 bits', () => {
    const texts = ['', 'abc', '- 1', ' \t-2147483649', '+99999999999']
    expect(texts.map(stoiError)).toEqual([
      'invalid stoi argument',
      'invalid stoi argument',
      'invalid stoi argument',
      'stoi argument out of range',
      'stoi argument out of range',
    ])
  })
})

describe('stof', () => {
  it('reads the decimal float at the start of text, rounded to the nearest float', () => {
    const read = ['1.5', '0.1', '  -2.5e3xyz', '.5', '5.', '1e', '1e+', '1E2', '\v+3', '1e-40']
    expect(read.map(stof)).toEqual([
      1.5,
      Math.fround(0.1),
      -2500,
      0.5,
      5,
      1,
      1,
      100,
      3,
      Math.fround(1e-40),
    ])
    expect([stof('1e+2'), stof('100e-2'), stof('1000')]).toEqual([100, 1, 1000])
  })

  it('rounds the exact value of decimals, ties to even, by their first 768 significant digits', () => {
    const half = '1.000000059604644775390625'
    expect(stof(half)).toBe(1)
    expect(stof(`${half}0001`)).toBe(1 + 2 ** -23)
    expect(stof(`${half}${'0'.repeat(742)}1`)).toBe(1 + 2 ** -23)
    expect(stof(`${half}${'0'.repeat(743)}1`)).toBe(1)
    expect(stof(`0.${'0'.repeat(1000)}${half.replace('.', '')}${'0'.repeat(742)}1e1001`)).toBe(
      1 + 2 ** -23,
    )
  })

  it('reads zeros, infinities and NaNs, with their signs', () => {
    const read = ['0', '-0', '0e99999', '0.000', '-0.0e-9999', 'inf', '-INFINITY', 'Infinite']
    expect(read.map(stof)).toEqual([0, -0, 0, 0, -0, Infinity, -Infinity, Infinity])
    expect([stof('nan'), stof('-NaN(ind)')]).toEqual([NaN, NaN])
  })

  it('reads hexadecimal floats, and 0x without digits as 0', () => {
    const read = ['0x1p3', '0X1.8P1', '0x.8', '0x', '-0xg', '0x1e5', '0x0.0001p0', '0x10p-4']
    expect(read.map(stof)).toEqual([8, 3, 0.5, 0, -0, 485, 2 ** -16, 1])
    expect([stof('0xFFp-4'), stof('0xA'), stof('0x1p+3')]).toEqual([15.9375, 10, 8])
  })

  it('reads denormals, but nothing for floats too large or so small that they round to 0', () => {
    const max = (2 - 2 ** -23) * 2 ** 127
    const read = ['0x1p-149', '0x1.000001p-150', '1e-45', '7.1e-46', '3.4028235e38', '0x1p127']
    expect(read.map(stof)).toEqual([2 ** -149, 2 ** -149, 2 ** -149, 2 ** -149, max, 2 ** 127])
    const out = ['0x1p-150', '7e-46', '1e-50', '3.4028236e38', '0x1.ffffffp127', '0x1p128', '1e39']
    expect(out.map(stof)).toEqual(out.map(() => undefined))
  })

  it('reads nothing where there is no float, or where MSVC gives up on its exponent', () => {
    const texts = ['', 'abc', '.', '+', 'e5', '- 1', '+-1', 'in', '.e1']
    expect(texts.map(stof)).toEqual(texts.map(() => undefined))
    expect(stof(`0.${'0'.repeat(5300)}1e5301`)).toBeUndefined()
    expect(stof(`0.${'0'.repeat(5200)}1e5201`)).toBeUndefined()
    expect(stof(`0.${'0'.repeat(5199)}1e5200`)).toBe(1)
    expect(stof(`1${'0'.repeat(5300)}e-5300`)).toBeUndefined()
    expect(stof('1e5200')).toBeUndefined()
    expect(stof(`0.${'0'.repeat(5000)}1e5000`)).toBe(Math.fround(0.1))
    expect(stof(`0.${'0'.repeat(5000)}1e05000`)).toBe(Math.fround(0.1))
  })
})
