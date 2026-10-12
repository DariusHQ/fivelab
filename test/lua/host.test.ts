import { describe, expect, it } from 'vitest'

import {
  CFunction,
  LuaError,
  LuaRef,
  LuaVector,
  MAX_NESTED_CALLS,
  type LuaValue,
} from '../../src/core/lua/index.ts'
import { createRuntime } from './helpers.ts'

describe('host functions', () => {
  it('receive Lua arguments and return any number of results', async () => {
    const lua = (await createRuntime()).newState()
    const seen: LuaValue[][] = []
    lua.setGlobal(
      'host',
      lua.hostFunction((args) => {
        seen.push(args.all())
        return [args.count, 'two', new LuaVector('vector2', 1, 2)]
      }),
    )
    lua.setGlobal(
      'none',
      lua.hostFunction(() => {}),
    )
    const results = lua.run(
      `local a, b, c = host(nil, false, 7, 0.5, 's', vec(1, 2, 3))
       return a, b, c.y, select('#', none())`,
      '=test',
    )
    expect(results).toEqual([6, 'two', 2, 0])
    expect(seen).toEqual([[null, false, 7, 0.5, 's', new LuaVector('vector3', 1, 2, 3)]])
  })

  it('read binary-safe bytes', async () => {
    const lua = (await createRuntime()).newState()
    let bytes: Uint8Array | null = null
    lua.setGlobal(
      'take',
      lua.hostFunction((args) => {
        bytes = args.bytes(1)
      }),
    )
    lua.run(String.raw`take('\0\1\255')`, '=test')
    expect(bytes).toEqual(new Uint8Array([0, 1, 255]))
  })

  it('read integers as lua_tointeger does', async () => {
    const lua = (await createRuntime()).newState()
    const integers: bigint[] = []
    lua.setGlobal(
      'take',
      lua.hostFunction((args) => {
        for (let i = 1; i <= args.count + 1; i++) integers.push(args.integer(i))
      }),
    )
    lua.run(
      `take(math.maxinteger, -3, 2.0, 2.5, '12', ' 0x10 ', '1.0', '1.5', nil, true, {})`,
      '=test',
    )
    expect(integers).toEqual([2n ** 63n - 1n, -3n, 2n, 0n, 12n, 16n, 1n, 0n, 0n, 0n, 0n, 0n])
  })

  it('turn JavaScript exceptions into Lua errors', async () => {
    const lua = (await createRuntime()).newState()
    const throwing = (value: unknown) =>
      lua.hostFunction(() => {
        throw value
      })
    lua.setGlobal('typeError', throwing(new TypeError('bad input')))
    lua.setGlobal('luaError', throwing(new LuaError('exact message')))
    lua.setGlobal('opaque', throwing(Object.create(null)))
    lua.setGlobal(
      'unsupported',
      lua.hostFunction(() => (() => {}) as never),
    )
    expect(lua.run(`return pcall(typeError)`, '=test')).toEqual([false, 'TypeError: bad input'])
    expect(lua.run(`return pcall(luaError)`, '=test')).toEqual([false, 'exact message'])
    expect(lua.run(`return pcall(opaque)`, '=test')).toEqual([
      false,
      'host function threw a value that cannot be converted to a string',
    ])
    expect(lua.run(`return pcall(unsupported)`, '=test')).toEqual([
      false,
      'TypeError: Cannot pass a function to Lua',
    ])
    expect(() => lua.run(`typeError()`, '=test')).toThrow(LuaError)
    expect(lua.run(`return 'alive'`, '=test')).toEqual(['alive'])
  })

  it('can call back into their own state on the calling thread', async () => {
    const lua = (await createRuntime()).newState()
    const [inner] = lua.run(
      `return function() local co, main = coroutine.running(); return co, main end`,
      '=test',
    )
    lua.setGlobal(
      'reenter',
      lua.hostFunction(() => lua.call(inner as LuaRef)),
    )
    const [same, main] = lua.run(
      `local co = coroutine.create(function()
         local nested, isMain = reenter()
         return nested == coroutine.running(), isMain
       end)
       local ok, same, main = coroutine.resume(co)
       return same, main`,
      '=test',
    )
    expect(same).toBe(true)
    expect(main).toBe(false)
  })

  it('can call back into their own state on the main thread', async () => {
    const lua = (await createRuntime()).newState()
    const [inner] = lua.run(
      `return function() local co, main = coroutine.running(); return main end`,
      '=test',
    )
    const [fail] = lua.run(`return function() error('on main', 0) end`, '=test')
    lua.setGlobal(
      'reenter',
      lua.hostFunction(() => lua.callOnMain(inner as LuaRef)),
    )
    lua.setGlobal(
      'fail',
      lua.hostFunction(() => lua.callOnMain(fail as LuaRef)),
    )
    const results = lua.run(
      `local co
       co = coroutine.create(function()
         local main = reenter()
         return main, coroutine.status(co), pcall(fail)
       end)
       return coroutine.resume(co)`,
      '=test',
    )
    expect(results).toEqual([true, true, 'running', false, 'on main'])
  })

  it('carry errors through nested calls in both directions', async () => {
    const lua = (await createRuntime()).newState()
    const [thrower] = lua.run(`return function() error('deep', 0) end`, '=test')
    lua.setGlobal(
      'relay',
      lua.hostFunction(() => {
        try {
          lua.call(thrower as LuaRef)
        } catch (error) {
          expect(error).toBeInstanceOf(LuaError)
          throw error
        }
      }),
    )
    expect(lua.run(`return pcall(relay)`, '=test')).toEqual([false, 'deep'])
  })

  it('let Lua errors raised by the runtime unwind through JavaScript', async () => {
    const lua = (await createRuntime()).newState({ memoryLimit: 512 * 1024 })
    lua.setGlobal(
      'big',
      lua.hostFunction(() => 'x'.repeat(2 * 1024 * 1024)),
    )
    expect(lua.run(`return pcall(big)`, '=test')).toEqual([false, 'not enough memory'])
    expect(lua.run(`return 'alive'`, '=test')).toEqual(['alive'])
  })

  it('cannot yield across a host call', async () => {
    const lua = (await createRuntime()).newState()
    const [yielder] = lua.run(`return function() coroutine.yield() end`, '=test')
    lua.setGlobal(
      'call',
      lua.hostFunction(() => lua.call(yielder as LuaRef)),
    )
    const [ok, message] = lua.run(
      `return coroutine.resume(coroutine.create(function() return call() end))`,
      '=test',
    )
    expect(ok).toBe(false)
    expect(message).toMatch(/attempt to yield across a C-call boundary/)
  })

  it('connect states, including states in different runtimes', async () => {
    const first = await createRuntime()
    const second = await createRuntime()
    const a = first.newState()
    const b = first.newState()
    const c = second.newState()
    const [double] = b.run(`return function(n) return n * 2 end`, '=b')
    const [boom] = c.run(`return function() error('from c', 0) end`, '=c')
    a.setGlobal(
      'double',
      a.hostFunction((args) => b.call(double as LuaRef, args.get(1))),
    )
    a.setGlobal(
      'boom',
      a.hostFunction(() => c.call(boom as LuaRef)),
    )
    expect(a.run(`return double(21)`, '=a')).toEqual([42])
    expect(a.run(`return pcall(boom)`, '=a')).toEqual([false, 'from c'])
  })

  it('stop runaway recursion between JavaScript and Lua with an error', async () => {
    const lua = (await createRuntime()).newState()
    let depth = 0
    const [down] = lua.run(`return function(n) return recurse(n) end`, '=test')
    lua.setGlobal(
      'recurse',
      lua.hostFunction((args) => {
        depth = Math.max(depth, Number(args.get(1)))
        return lua.call(down as LuaRef, Number(args.get(1)) + 1)
      }),
    )
    expect(() => lua.call(down as LuaRef, 1)).toThrow(/Too many nested calls/)
    expect(depth).toBe(MAX_NESTED_CALLS)
    expect(lua.run(`return 'alive'`, '=test')).toEqual(['alive'])
  })

  it('reject host functions of another state', async () => {
    const runtime = await createRuntime()
    const a = runtime.newState()
    const b = runtime.newState()
    const fn = a.hostFunction(() => 1)
    expect(() => b.setGlobal('fn', fn)).toThrow('another Lua state')
  })

  it('name argument types as Lua argument errors do', async () => {
    const lua = (await createRuntime()).newState()
    const names: string[] = []
    lua.setGlobal(
      'types',
      lua.hostFunction((args) => {
        for (let i = 1; i <= args.count + 1; i++) names.push(args.typeName(i))
      }),
    )
    lua.run(`types(nil, true, 1, vec(1, 2), 's', {}, print, coroutine.create(print))`, '=test')
    expect(names).toEqual([
      'nil',
      'boolean',
      'number',
      'vector',
      'string',
      'table',
      'function',
      'thread',
      'no value',
    ])
  })
})

describe('C functions', () => {
  it('close over upvalues', async () => {
    const lua = (await createRuntime()).newState()
    const marker = lua.cFunction(CFunction.resultAsInteger)
    const invoke = lua.cFunction(
      CFunction.invokeNative,
      lua.hostFunction(() => 'invoked'),
    )
    lua.setGlobal('marker', marker)
    lua.setGlobal('invoke', invoke)
    expect(lua.run('return type(marker()), marker() == marker(), invoke(0)', '=test')).toEqual([
      'userdata',
      true,
      'invoked',
    ])
  })

  it('check arguments as FiveM checks them, in either order', async () => {
    const lua = (await createRuntime()).newState()
    const checked = lua.cFunction(CFunction.checked)
    const [types] = lua.run(
      `return function(a, b, c, d) return type(a), math.type(b), math.type(c), type(d) end`,
      '=test',
    )
    lua.setGlobal('forward', lua.call(checked, 'sni.', types!)[0]!)
    lua.setGlobal('backward', lua.call(checked, '<sni', types!)[0]!)
    expect(lua.run(`return forward(1, '2', 3.0, {})`, '=test')).toEqual([
      'string',
      'float',
      'integer',
      'table',
    ])
    const failure = (call: string) =>
      lua.run(`return select(2, pcall(function() ${call} end))`, '=test')
    expect(failure(`forward()`)).toEqual([
      "test:1: bad argument #1 to 'forward' (string expected, got no value)",
    ])
    expect(failure(`backward()`)).toEqual([
      "test:1: bad argument #3 to 'backward' (number expected, got no value)",
    ])
    expect(failure(`backward({}, 1, 2)`)).toEqual([
      "test:1: bad argument #1 to 'backward' (string expected, got table)",
    ])
  })
})
