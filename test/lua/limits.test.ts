import { describe, expect, it } from 'vitest'

import { createRuntime } from './helpers.ts'

describe('limits', () => {
  it('reports Lua stack overflows', async () => {
    const lua = (await createRuntime()).newState()
    expect(() => lua.run(`local function f() return 1 + f() end return f()`, '=test')).toThrow(
      /stack overflow/,
    )
    expect(lua.run(`return 'alive'`, '=test')).toEqual(['alive'])
  })

  it('reaches the C stack limit without overflowing the native stack', async () => {
    const lua = (await createRuntime()).newState()
    const [depth, message] = lua.run(
      `local depth = 0
       local function f()
         depth = depth + 1
         local ok, err = pcall(f)
         if not ok then error(err, 0) end
       end
       local ok, err = pcall(f)
       return depth, err`,
      '=test',
    )
    expect(depth).toBeGreaterThan(150)
    expect(depth).toBeLessThanOrEqual(200)
    expect(message).toMatch(/stack overflow/)
  })

  it('bounds the nesting depth of json and msgpack', async () => {
    const lua = (await createRuntime()).newState()
    const [jsonOk, jsonError, depth] = lua.run(
      `local t = {} local c = t for i = 1, 10000 do c[1] = {} c = c[1] end
       local depth, v = 0, msgpack.unpack(msgpack.pack(t))
       while type(v) == 'table' do depth = depth + 1 v = v[1] end
       local ok, err = pcall(json.encode, t)
       return ok, err, depth`,
      '=test',
    )
    expect(jsonOk).toBe(false)
    expect(jsonError).toBe('maximum table nesting depth exceeded')
    // msgpack packs 16 levels and nil below them.
    expect(depth).toBe(16)
    expect(lua.run(`return 'alive'`, '=test')).toEqual(['alive'])
  })

  it('is deterministic for a fixed clock', async () => {
    const sample = async () => {
      const lua = (await createRuntime({ now: () => 1_700_000_000_000 })).newState()
      return lua.run(
        `local keys = {}
         for k in pairs({alpha = 1, beta = 2, gamma = 3, delta = 4, epsilon = 5}) do
           keys[#keys + 1] = k
         end
         return math.random(1, 1e9), math.random(), table.concat(keys, ',')`,
        '=test',
      )
    }
    expect(await sample()).toEqual(await sample())
  })

  it('hosts dozens of states in one runtime', async () => {
    const runtime = await createRuntime()
    const states = Array.from({ length: 40 }, () => runtime.newState())
    for (const [i, lua] of states.entries()) {
      lua.run(
        `local t = {} for i = 1, 1000 do t[i] = {id = i, name = 'item' .. i} end
         _G.items = t`,
        `=state${i}`,
      )
    }
    const used = states.reduce((sum, lua) => sum + lua.memoryUsed, 0)
    expect(used).toBeLessThan(40 * 1024 * 1024)
    for (const lua of states) lua.close()
  })
})
