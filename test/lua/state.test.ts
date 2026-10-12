import { describe, expect, it } from 'vitest'

import { LuaFloat, LuaError, LuaRef, LuaVector } from '../../src/core/lua/index.ts'
import { createRuntime, thrown } from './helpers.ts'

describe('LuaState', () => {
  it('runs code and reads every kind of result', async () => {
    const lua = (await createRuntime()).newState()
    const [nil, yes, int, float, text, vector, table, fn] = lua.run(
      `return nil, true, 42, 1.5, 'héllo', vector3(1, 2, 3), {}, print`,
      '=test',
    )
    expect(nil).toBeNull()
    expect(yes).toBe(true)
    expect(int).toBe(42)
    expect(float).toBe(1.5)
    expect(text).toBe('héllo')
    expect(vector).toEqual(new LuaVector('vector3', 1, 2, 3))
    expect(table).toBeInstanceOf(LuaRef)
    expect((table as LuaRef).type).toBe('table')
    expect((fn as LuaRef).type).toBe('function')
  })

  it('keeps integers and floats apart', async () => {
    const lua = (await createRuntime()).newState()
    expect(lua.run(`return math.maxinteger, math.mininteger, 2^53, -0.0`, '=test')).toEqual([
      9223372036854775807n,
      -9223372036854775808n,
      9007199254740992,
      -0,
    ])
    const [types] = lua.run(
      `local a, b, c, d, e = ...
       return table.concat({math.type(a), math.type(b), math.type(c), math.type(d), math.type(e)}, ' ')`,
      '=test',
      1,
      1.5,
      2n ** 62n,
      -0,
      2 ** 60,
    )
    expect(types).toBe('integer float integer float float')
  })

  it('pushes integral numbers as floats when asked to', async () => {
    const lua = (await createRuntime()).newState()
    const [types] = lua.run(
      `local a, b = ... return math.type(a) .. ' ' .. tostring(b)`,
      '=test',
      new LuaFloat(2),
      new LuaFloat(-0.5),
    )
    expect(types).toBe('float -0.5')
  })

  it('passes strings, bytes, vectors and nil into Lua', async () => {
    const lua = (await createRuntime()).newState()
    const bytes = new Uint8Array([0, 255, 10, 0])
    const [len, b2, text, vtype, vz, isnil, count] = lua.run(
      `local b, s, v, n, u = ...
       return #b, string.byte(b, 2), s .. '!', type(v), v.z, n == nil and u == nil, select('#', ...)`,
      '=test',
      bytes,
      'ünïcode ✓',
      new LuaVector('vector4', 1, 2, 3, 4),
      null,
      undefined,
    )
    expect([len, b2, text, vtype, vz, isnil, count]).toEqual([
      4,
      255,
      'ünïcode ✓!',
      'vector4',
      3,
      true,
      5,
    ])
  })

  it('maps quaternion components by name', async () => {
    const lua = (await createRuntime()).newState()
    // The constructor takes w first.
    const [q] = lua.run(`return quat(1, 2, 3, 4)`, '=test')
    expect(q).toEqual(new LuaVector('quat', 2, 3, 4, 1))
    expect(lua.run(`local q = ... return q.x, q.y, q.z, q.w`, '=test', q)).toEqual([2, 3, 4, 1])
  })

  it('reads and writes globals without metamethods', async () => {
    const lua = (await createRuntime()).newState()
    lua.setGlobal('answer', 42)
    lua.run(`setmetatable(_G, {__index = function() return 'meta' end})`, '=test')
    expect(lua.getGlobal('answer')).toBe(42)
    expect(lua.getGlobal('missing')).toBeNull()
    expect(lua.run(`return missing`, '=test')).toEqual(['meta'])
  })

  it('isolates states from each other', async () => {
    const runtime = await createRuntime()
    const a = runtime.newState()
    const b = runtime.newState()
    a.run(`shared = 'a'`, '=a')
    expect(b.run(`return shared`, '=b')).toEqual([null])
  })

  it('reports syntax errors', async () => {
    const lua = (await createRuntime()).newState()
    const error = thrown(() => lua.load(`return +`, '@@res/client.lua'))
    expect(error).toBeInstanceOf(LuaError)
    expect(error).toMatchObject({
      kind: 'syntax',
      message: "@res/client.lua:1: unexpected symbol near '+'",
    })
  })

  it('reports runtime errors with a traceback and keeps working', async () => {
    const lua = (await createRuntime()).newState()
    const error = thrown(() =>
      lua.run(`local function f() local t = nil; return t.x end\nf()`, '@@res/server.lua'),
    )
    expect(error).toBeInstanceOf(LuaError)
    const luaError = error as LuaError
    expect(luaError.kind).toBe('runtime')
    expect(luaError.message).toBe("@res/server.lua:1: attempt to index a nil value (local 't')")
    expect(luaError.luaTraceback).toContain('stack traceback:')
    expect(luaError.luaTraceback).toContain("@res/server.lua:1: in local 'f'")
    expect(lua.run(`return 1 + 1`, '=test')).toEqual([2])
  })

  it('describes error objects that are not strings', async () => {
    const lua = (await createRuntime()).newState()
    expect(() =>
      lua.run(`error(setmetatable({}, {__tostring = function() return 'custom' end}))`, '=t'),
    ).toThrow('custom')
    expect(() => lua.run(`error(42)`, '=t')).toThrow('42')
    expect(() => lua.run(`error({})`, '=t')).toThrow(/^table: [0-9a-f]{16}$/)
  })

  it('calls Lua functions through references', async () => {
    const lua = (await createRuntime()).newState()
    const [add] = lua.run(`return function(a, b) return a + b, 'sum' end`, '=test')
    expect((add as LuaRef).call(2, 3)).toEqual([5, 'sum'])
    ;(add as LuaRef).release()
    expect(() => lua.call(add as LuaRef)).toThrow('released')
  })

  it('returns strings as their bytes when asked to', async () => {
    const lua = (await createRuntime()).newState()
    const [fn] = lua.run(`return function(...) return '\\xff\\0a', 1, ... end`, '=test')
    expect(lua.callWith({ bytes: true }, fn as LuaRef, 'b', null)).toEqual([
      new Uint8Array([0xff, 0, 0x61]),
      1,
      new Uint8Array([0x62]),
      null,
    ])
    expect(lua.callWith({}, fn as LuaRef)).toEqual(['�\0a', 1])
  })

  it('rejects references from another state', async () => {
    const runtime = await createRuntime()
    const a = runtime.newState()
    const b = runtime.newState()
    const [t] = a.run(`return {}`, '=a')
    expect(() => b.call(t as LuaRef)).toThrow('another Lua state')
    expect(b.run(`return 'still fine'`, '=b')).toEqual(['still fine'])
  })

  it('tracks memory and enforces a limit', async () => {
    const runtime = await createRuntime()
    const lua = runtime.newState({ memoryLimit: 1024 * 1024 })
    expect(lua.memoryLimit).toBe(1024 * 1024)
    const before = lua.memoryUsed
    expect(before).toBeGreaterThan(10_000)
    expect(() => lua.run(`return string.rep('x', 2 * 1024 * 1024)`, '=test')).toThrow(
      expect.objectContaining({ kind: 'memory', message: 'not enough memory' }),
    )
    lua.collectGarbage()
    expect(lua.memoryUsed).toBeLessThan(before + 4096)
    expect(lua.run(`return #string.rep('x', 1000)`, '=test')).toEqual([1000])
    lua.memoryLimit = 0
    expect(lua.run(`return #string.rep('x', 2 * 1024 * 1024)`, '=test')).toEqual([2 * 1024 * 1024])
  })

  it('rejects invalid memory limits', async () => {
    const runtime = await createRuntime()
    const lua = runtime.newState()
    expect(() => {
      lua.memoryLimit = -1
    }).toThrow(RangeError)
    expect(() => runtime.newState({ memoryLimit: 1.5 })).toThrow('Invalid memory limit: 1.5')
    expect(lua.memoryLimit).toBe(0)
  })

  it('runs finalizers when closed and refuses use afterwards', async () => {
    const runtime = await createRuntime()
    const lua = runtime.newState()
    const closed: string[] = []
    lua.setGlobal(
      'note',
      lua.hostFunction((args) => {
        closed.push(String(args.get(1)))
      }),
    )
    lua.run(`gcme = setmetatable({}, {__gc = function() note('gc') end})`, '=test')
    lua.close()
    expect(closed).toEqual(['gc'])
    expect(lua.closed).toBe(true)
    expect(() => lua.run(`return 1`, '=test')).toThrow('closed')
  })
})
