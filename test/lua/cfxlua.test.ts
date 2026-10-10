import { describe, expect, it } from 'vitest'

import { LuaVector, type LuaRef } from '../../src/core/lua/index.ts'
import { createRuntime } from './helpers.ts'

async function fivem() {
  const lua = (await createRuntime()).newState()
  lua.setGlobal('require', lua.requireFunction())
  return lua
}

describe('CfxLua', () => {
  it('identifies as LuaGLM 5.4', async () => {
    const lua = await fivem()
    expect(lua.run(`return _VERSION`, '=test')).toEqual(['LuaGLM 5.4'])
  })

  it('has native vectors and quaternions', async () => {
    const lua = await fivem()
    expect(
      lua.run(
        `local v = vector3(1, 2, 3)
         return type(v), tostring(v), #vec(3, 4), v.xy, v + vec(1, 1, 1), v * 2,
                v == vec(1, 2, 3), type(quat(90.0, vec(0, 0, 1)))`,
        '=test',
      ),
    ).toEqual([
      'vector3',
      'vec3(1.000000, 2.000000, 3.000000)',
      5,
      new LuaVector('vector2', 1, 2),
      new LuaVector('vector3', 2, 3, 4),
      new LuaVector('vector3', 2, 4, 6),
      true,
      'quat',
    ])
  })

  it('keeps vectors immutable and usable as table keys', async () => {
    const lua = await fivem()
    expect(
      lua.run(
        `local t = {[vec(1, 2, 3)] = 'found'}
         local ok, err = pcall(function() local v = vec(1, 2, 3); v.x = 5 end)
         return t[vec(1, 2, 3)], ok, err`,
        '=test',
      ),
    ).toEqual(['found', false, "test:2: attempt to mutate a vector value (local 'v')"])
  })

  it('parses the CfxLua syntax extensions', async () => {
    const lua = await fivem()
    const source = [
      'local n = 5; n += 2; n *= 3; n <<= 1',
      'local t = {x = {y = 1}}',
      "local source = {a = 'A', b = 'B'}",
      'local a, b in source',
      'local set = {.red, .green}',
      '/* a C comment */',
      "return n, t?.x?.y, t?.missing?.y, a, b, set.red, set.blue, `hello`, joaat('hello')",
    ].join('\n')
    expect(lua.run(source, '=test')).toEqual([
      42,
      1,
      null,
      'A',
      'B',
      true,
      null,
      -922937317,
      -922937317,
    ])
  })

  it('has defer, each and __ipairs', async () => {
    const lua = await fivem()
    expect(
      lua.run(
        `local log = {}
         do local _ <close> = defer(function() log[#log + 1] = 'deferred' end) end
         for _, v in each({10, 20}) do log[#log + 1] = v end
         local proxy = setmetatable({}, {__ipairs = function(t)
           return function(_, i) if i < 3 then return i + 1, i end end, t, 0
         end})
         for i in ipairs(proxy) do log[#log + 1] = i end
         return table.concat(log, ',')`,
        '=test',
      ),
    ).toEqual(['deferred,10,20,1,2,3'])
  })

  it('extends the standard libraries like FiveM', async () => {
    const lua = await fivem()
    expect(
      lua.run(
        `return string.strtrim('  x  '), table.type({1, 2}), table.type({a = 1}),
                select('#', string.strsplit(',', 'a,b,c')), type(string.blob(4))`,
        '=test',
      ),
    ).toEqual(['x', 'array', 'hash', 3, 'string'])
  })

  it('round-trips json and msgpack, vectors included', async () => {
    const lua = await fivem()
    expect(
      lua.run(
        `local data = {1, 'two', {three = 3}}
         local packed = msgpack.unpack(msgpack.pack({pos = vector3(1.5, 2, 3)}))
         return json.encode(data), json.decode('[1,{"a":null}]')[2].a, json.encode(json.null),
                type(packed.pos), packed.pos.x`,
        '=test',
      ),
    ).toEqual(['[1,"two",{"three":3}]', null, 'null', 'vector3', 1.5])
  })

  it('packs vector components little-endian, as FiveM does', async () => {
    const lua = await fivem()
    const [hex] = lua.run(
      `return (msgpack.pack(vector2(1, 2)):gsub('.', function(c)
         return string.format('%02x', c:byte())
       end))`,
      '=test',
    )
    expect(hex).toBe('d714' + '0000803f' + '00000040')
  })

  it('opens glm through require and sets the global', async () => {
    const lua = await fivem()
    expect(
      lua.run(`local g = require('glm'); return g == glm, require('json') == json`, '=t'),
    ).toEqual([true, true])
    expect(() => lua.run(`require('socket')`, '=t')).toThrow("module 'socket' not found")
  })

  it('is sandboxed like FiveM', async () => {
    const lua = await fivem()
    expect(
      lua.run(
        `return debug.sethook, debug.getregistry, io, os, package,
                tostring({}):match('^table: %x+$') ~= nil`,
        '=test',
      ),
    ).toEqual([null, null, null, null, null, true])
  })

  it('collects garbage in generational mode, like FiveM', async () => {
    const lua = await fivem()
    expect(lua.run(`return collectgarbage('generational')`, '=test')).toEqual(['generational'])
  })

  it('formats tostring of tables with process-wide opaque ids', async () => {
    const runtime = await createRuntime()
    const a = runtime.newState()
    const b = runtime.newState()
    const [first] = a.run(`return tostring({})`, '=a')
    const [second] = b.run(`return tostring({})`, '=b')
    expect(first).toBe('table: 4f1bbcdcbfa53e09')
    expect(second).toBe('table: 1e3779b97f4a7c12')
  })

  it('keeps closures it returns callable', async () => {
    const lua = await fivem()
    const [counter] = lua.run(`local n = 0 return function() n += 1 return n end`, '=t')
    ;(counter as LuaRef).call()
    expect((counter as LuaRef).call()).toEqual([2])
  })
})
