import { describe, expect, it } from 'vitest'

import { MemoryFileSystem } from '../../src/core/engine/index.ts'
import { runFile } from '../../src/runner/index.ts'
import { cfxlua } from '../lua/helpers.ts'

/**
 * Runs each case as a test of its own, on a line of its own, and returns
 * what each failed with, or null for those that passed. AT in the messages
 * of cases stands for the position of their line.
 */
async function check(cases: readonly (readonly [code: string, message: string | null])[]) {
  const source = cases.map(([code], index) => `it('${index + 1}', function() ${code} end)`)
  const result = await runFile(
    { path: 'tests/x.test.lua', source: source.join('\n') },
    { cfxlua: await cfxlua(), project: { files: () => new MemoryFileSystem(), commands: [] } },
  )
  expect(result.failure).toBe(undefined)
  const outcomes = result.tests.map(({ failures }) => failures[0]?.message ?? null)
  const expected = cases.map(
    ([, message], index) =>
      message?.replace('AT', `@fiverunner/tests/x.test.lua:${index + 1}:`) ?? null,
  )
  expect(outcomes).toEqual(expected)
}

describe('expect', () => {
  it('compares values with toBe as they are, NaN as NaN', async () => {
    await check([
      ['expect(1).toBe(1)', null],
      ['expect(1).toBe(1.0)', null],
      ['expect(0/0).toBe(0/0)', null],
      ['local t = {} expect(t).toBe(t)', null],
      ["expect('a').toBe('b')", 'expected "a" to be "b"'],
      ['expect(1).toBe(2.0)', 'expected 1 to be 2.0'],
      [
        'expect({ 1 }).toBe({ 1 })',
        'expected { 1 } to be { 1 }, the same table: toEqual compares what tables hold',
      ],
      ['expect({ 1 }).toBe({ 2 })', 'expected { 1 } to be { 2 }'],
      ['expect(1).never.toBe(1)', 'expected 1 not to be 1'],
      ['expect(1).never.toBe(2)', null],
    ])
  })

  it('compares tables with toEqual by what they hold, whatever their metatables', async () => {
    await check([
      ['expect({ a = { 1, 2 }, [true] = 3 }).toEqual({ a = { 1, 2 }, [true] = 3 })', null],
      [
        'expect({ a = 1 }).toEqual({ a = 1, b = 2 })',
        'expected { a = 1 } to equal { a = 1, b = 2 }',
      ],
      [
        'expect({ a = 1, b = 2 }).toEqual({ a = 1 })',
        'expected { a = 1, b = 2 } to equal { a = 1 }',
      ],
      ['expect({ 1, 2 }).toEqual({ 2, 1 })', 'expected { 1, 2 } to equal { 2, 1 }'],
      ['expect({ 0/0 }).toEqual({ 0/0 })', null],
      ['expect(vector3(1, 2, 3)).toEqual(vector3(1, 2, 3))', null],
      [
        'expect({ vector2(1, 2) }).toEqual({ vector2(1, 3) })',
        'expected { vec2(1.000000, 2.000000) } to equal { vec2(1.000000, 3.000000) }',
      ],
      ['local a = {} a.self = a local b = {} b.self = b expect(a).toEqual(b)', null],
      ['expect(setmetatable({}, { __index = { x = 1 } })).toEqual({})', null],
      ["expect(1).toEqual('1')", 'expected 1 to equal "1"'],
      ['expect({ 1 }).never.toEqual({ 1 })', 'expected { 1 } not to equal { 1 }'],
    ])
  })

  it('tells truthy, falsy and nil values apart', async () => {
    await check([
      ['expect(0).toBeTruthy()', null],
      ["expect('').toBeTruthy()", null],
      ['expect(nil).toBeTruthy()', 'expected nil to be truthy'],
      ['expect(false).toBeTruthy()', 'expected false to be truthy'],
      ['expect(1).never.toBeTruthy()', 'expected 1 not to be truthy'],
      ['expect(false).toBeFalsy()', null],
      ['expect(nil).toBeFalsy()', null],
      ['expect(0).toBeFalsy()', 'expected 0 to be falsy'],
      ['expect(false).never.toBeFalsy()', 'expected false not to be falsy'],
      ['expect(nil).toBeNil()', null],
      ['expect(false).toBeNil()', 'expected false to be nil'],
      ['expect(nil).never.toBeNil()', 'expected the value not to be nil'],
      ['expect(1).never.toBeNil()', null],
    ])
  })

  it('compares numbers', async () => {
    await check([
      ['expect(2).toBeGreaterThan(1)', null],
      ['expect(1).toBeGreaterThan(1)', 'expected 1 to be greater than 1'],
      ['expect(1).toBeGreaterThanOrEqual(1)', null],
      ['expect(0).toBeGreaterThanOrEqual(1)', 'expected 0 to be greater than or equal to 1'],
      ['expect(1).toBeLessThan(2)', null],
      ['expect(2).toBeLessThan(2)', 'expected 2 to be less than 2'],
      ['expect(2).toBeLessThanOrEqual(2)', null],
      ['expect(2.5).toBeLessThanOrEqual(1)', 'expected 2.5 to be less than or equal to 1'],
      ['expect(2).never.toBeGreaterThan(1)', 'expected 2 not to be greater than 1'],
      [
        "expect('1').toBeGreaterThan(0)",
        'AT toBeGreaterThan compares numbers, not string and number',
      ],
      ['expect(1).toBeLessThan(nil)', 'AT toBeLessThan compares numbers, not number and nil'],
      ['expect(0.1 + 0.2).toBeCloseTo(0.3)', null],
      ['expect(0.1).toBeCloseTo(0.2, 1)', 'expected 0.1 to be close to 0.2, within 0.05'],
      ['expect(1.04).toBeCloseTo(1, 1)', null],
      ['expect(math.huge).toBeCloseTo(math.huge)', null],
      ['expect(1).never.toBeCloseTo(1)', 'expected 1 not to be close to 1, within 0.005'],
      ["expect(1).toBeCloseTo('1')", 'AT toBeCloseTo compares numbers, not number and string'],
      ["expect(1).toBeCloseTo(1, '2')", 'AT toBeCloseTo takes a number of digits, not string'],
    ])
  })

  it('finds values in strings and tables', async () => {
    await check([
      ["expect('hello').toContain('ell')", null],
      ["expect('a.b').toContain('.')", null],
      ["expect('abc').toContain('.')", 'expected "abc" to contain "."'],
      ["expect('abc').toContain('d')", 'expected "abc" to contain "d"'],
      ['expect({ 1, 2 }).toContain(2)', null],
      ["expect({ a = 'x' }).toContain('x')", null],
      ['expect({ { 1 } }).toContain({ 1 })', 'expected { { 1 } } to contain { 1 }'],
      ['expect({ 1 }).never.toContain(1)', 'expected { 1 } not to contain 1'],
      ["expect('abc').toContain(1)", 'AT toContain finds strings in strings, not number'],
      ['expect(1).toContain(1)', 'AT toContain finds values in strings and tables, not in number'],
      ['expect({ { 1 } }).toContainEqual({ 1 })', null],
      [
        'expect({ { 1 } }).toContainEqual({ 2 })',
        'expected { { 1 } } to contain a value equal to { 2 }',
      ],
      [
        'expect({ { 1 } }).never.toContainEqual({ 1 })',
        'expected { { 1 } } not to contain a value equal to { 1 }',
      ],
      [
        "expect('a').toContainEqual('a')",
        'AT toContainEqual finds values in tables, not in string',
      ],
    ])
  })

  it('measures and matches strings and tables', async () => {
    await check([
      ["expect('abc').toHaveLength(3)", null],
      ['expect({ 1, 2 }).toHaveLength(2)', null],
      ['expect({ 1, 2 }).toHaveLength(3)', 'expected { 1, 2 } to have length 3, not 2'],
      ["expect('').never.toHaveLength(0)", 'expected "" not to have length 0'],
      ['expect(12).toHaveLength(2)', 'AT toHaveLength measures strings and tables, not number'],
      ["expect('player 12').toMatch('%d+$')", null],
      ["expect('player').toMatch('^%d')", 'expected "player" to match "^%d"'],
      ["expect('x').never.toMatch('x')", 'expected "x" not to match "x"'],
      [
        "expect('x').toMatch('[')",
        "AT toMatch takes Lua patterns: malformed pattern (missing ']')",
      ],
      [
        "expect(1).toMatch('1')",
        'AT toMatch matches strings with patterns, not number with string',
      ],
    ])
  })

  it('calls functions to find what they throw', async () => {
    await check([
      ["expect(function() error('boom') end).toThrow()", null],
      ["expect(function() error('boom') end).toThrow('boo')", null],
      [
        "expect(function() error('boom', 0) end).toThrow('.')",
        'expected the function to throw an error with ".", but it threw "boom"',
      ],
      ['expect(function() error({}) end).toThrow()', null],
      ["expect(function() expect(1).toBe(2) end).toThrow('expected 1 to be 2')", null],
      [
        "expect(function() error('boom', 0) end).toThrow('bam')",
        'expected the function to throw an error with "bam", but it threw "boom"',
      ],
      ['expect(function() end).toThrow()', 'expected the function to throw'],
      ["expect(function() end).toThrow('x')", 'expected the function to throw an error with "x"'],
      ['expect(function() end).never.toThrow()', null],
      [
        "expect(function() error('boom', 0) end).never.toThrow()",
        'expected the function not to throw, but it threw "boom"',
      ],
      ["expect(function() error('boom', 0) end).never.toThrow('bam')", null],
      [
        "expect(function() error('boom', 0) end).never.toThrow('oo')",
        'expected the function not to throw an error with "oo", but it threw "boom"',
      ],
      ['expect(1).toThrow()', 'AT toThrow calls functions, not number'],
      ['expect(print).toThrow(1)', 'AT toThrow finds strings in what functions throw, not number'],
    ])
  })

  it('takes its matchers with a dot', async () => {
    await check([
      [
        'expect(1):toBe(1)',
        'AT call toBe with a dot, as in expect(value).toBe(...), not with a colon',
      ],
      [
        'local e = expect(1).never e:toBeNil()',
        'AT call toBeNil with a dot, as in expect(value).toBeNil(...), not with a colon',
      ],
    ])
  })

  it('shows values as Lua writes them', async () => {
    const many = Array.from({ length: 25 }, (_, index) => index + 1).join(', ')
    await check([
      [
        "expect({ 3, 'x', b = true, a = { 1 }, [10] = 1, ['not'] = 1, ['a b'] = 2 }).toBeNil()",
        'expected { 3, "x", [10] = 1, a = { 1 }, ["a b"] = 2, b = true, ["not"] = 1 } to be nil',
      ],
      [
        'expect({ { { { 1 } } }, { { {} } } }).toBeNil()',
        'expected { { { {...} } }, { { {} } } } to be nil',
      ],
      [
        `expect({ ${many} }).toBeNil()`,
        'expected { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, ... } to be nil',
      ],
      [
        'expect({ a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8, i = 9, j = 10, k = 11, l = 12, m = 13, n = 14, o = 15, p = 16, q = 17, r = 18, s = 19, t = 20 }).toBeNil()',
        'expected { a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8, i = 9, j = 10, k = 11, l = 12, m = 13, n = 14, o = 15, p = 16, q = 17, r = 18, s = 19, t = 20 } to be nil',
      ],
      ['expect(\'say "hi"\\n\\0\').toBeNil()', 'expected "say \\"hi\\"\\n\\0" to be nil'],
      ['expect({}).toBeNil()', 'expected {} to be nil'],
      ['expect(1.5).toBeNil()', 'expected 1.5 to be nil'],
      [
        "expect({ [true] = 1, [false] = 2, [0] = 'z', _x = 1, [1.5] = 2 }).toBeNil()",
        'expected { [false] = 2, [true] = 1, [0] = "z", [1.5] = 2, _x = 1 } to be nil',
      ],
      [
        "expect({ [10] = 'a', [9] = 'b' }).toBeNil()",
        'expected { [9] = "b", [10] = "a" } to be nil',
      ],
      [`expect({ ${letters(21)} }).toBeNil()`, `expected { ${letters(20)}, ... } to be nil`],
      [
        `expect({ ${numbers(19)}, x = 1, y = 2 }).toBeNil()`,
        `expected { ${numbers(19)}, x = 1, ... } to be nil`,
      ],
    ])
  })
})

/** The first `count` letters as the keys of a table, each with its place in the alphabet. */
function letters(count: number): string {
  const entries = Array.from({ length: count }, (_, index) => {
    return `${String.fromCharCode(97 + index)} = ${index + 1}`
  })
  return entries.join(', ')
}

/** The numbers from 1 to `count`. */
function numbers(count: number): string {
  return Array.from({ length: count }, (_, index) => index + 1).join(', ')
}
