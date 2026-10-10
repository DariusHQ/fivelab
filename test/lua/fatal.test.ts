import { describe, expect, it } from 'vitest'

import { LuaError, LuaFatalError } from '../../src/core/lua/index.ts'
import { createRuntime, thrown } from './helpers.ts'

describe('watchdog', () => {
  it('raises an error in a script that never yields', async () => {
    const lua = (await createRuntime()).newState()
    lua.setWatchdog({ timeoutMs: 50 })
    const start = performance.now()
    expect(() => lua.run(`local n = 0\nwhile true do n = n + 1 end`, '@@res/loop.lua')).toThrow(
      /^@res\/loop\.lua:2: script ran for more than 50 ms without yielding/,
    )
    expect(performance.now() - start).toBeLessThan(1000)
    expect(lua.run(`return 'alive'`, '=test')).toEqual(['alive'])
  })

  it('reaches loops inside coroutines', async () => {
    const lua = (await createRuntime()).newState()
    lua.setWatchdog({ timeoutMs: 50 })
    const [ok, message] = lua.run(
      `return coroutine.resume(coroutine.create(function() while true do end end))`,
      '=test',
    )
    expect(ok).toBe(false)
    expect(message).toMatch(/without yielding/)
  })

  it('stops a state that keeps catching its errors, sparing the others', async () => {
    const runtime = await createRuntime()
    const other = runtime.newState()
    const lua = runtime.newState()
    lua.setWatchdog({ timeoutMs: 30, killAfterMs: 120 })
    const error = thrown(() =>
      lua.run(`while true do pcall(function() while true do end end) end`, '=test'),
    )
    expect(error).toBeInstanceOf(LuaFatalError)
    expect(error).toMatchObject({ scope: 'state' })
    expect(lua.dead).toBe(error)
    expect(() => lua.run(`return 1`, '=test')).toThrow(error as Error)
    expect(runtime.crashed).toBeUndefined()
    expect(other.run(`return 'alive'`, '=other')).toEqual(['alive'])
    expect(runtime.newState().run(`return 'new'`, '=new')).toEqual(['new'])
  })

  it('rejects invalid options', async () => {
    const lua = (await createRuntime()).newState()
    expect(() => lua.setWatchdog({ timeoutMs: 0 })).toThrow(RangeError)
    expect(() => lua.setWatchdog({ timeoutMs: 100, killAfterMs: 50 })).toThrow(RangeError)
    expect(() => lua.setWatchdog({ timeoutMs: 100, interval: 0.5 })).toThrow(RangeError)
  })

  it('does not interrupt scripts that return in time', async () => {
    const lua = (await createRuntime()).newState()
    lua.setWatchdog({ timeoutMs: 1000 })
    expect(lua.run(`local n = 0 for i = 1, 1e6 do n = n + i end return n`, '=test')).toEqual([
      500000500000,
    ])
  })
})

describe('fatal errors', () => {
  it('turn a panic into a dead state and leave the runtime working', async () => {
    const runtime = await createRuntime()
    const other = runtime.newState()
    const lua = runtime.newState({ memoryLimit: 256 * 1024 })
    const error = thrown(() => lua.setGlobal('big', 'x'.repeat(1024 * 1024)))
    expect(error).toBeInstanceOf(LuaFatalError)
    expect(error).toMatchObject({
      scope: 'state',
      message: 'PANIC: unprotected error in call to Lua API (not enough memory)',
    })
    expect(() => lua.run(`return 1`, '=test')).toThrow(error as Error)
    expect(runtime.crashed).toBeUndefined()
    expect(other.run(`return 'alive'`, '=other')).toEqual(['alive'])
  })

  it('crash the whole runtime when the module traps', async () => {
    const runtime = await createRuntime()
    const other = runtime.newState()
    const lua = runtime.newState()
    lua.setGlobal(
      'corrupt',
      lua.hostFunction(() => {
        runtime.exports.fl_settop(0x7ffffff0, 0)
      }),
    )
    const error = thrown(() => lua.run(`pcall(corrupt)`, '=test'))
    expect(error).toBeInstanceOf(LuaFatalError)
    expect(error).toMatchObject({ scope: 'runtime' })
    expect(runtime.crashed).toBe(error)
    expect(() => other.run(`return 1`, '=other')).toThrow(error as Error)
    expect(() => runtime.newState()).toThrow(error as Error)
  })

  it('keep ordinary errors ordinary and the stack balanced', async () => {
    const runtime = await createRuntime()
    const lua = runtime.newState()
    expect(() => lua.run(`return ...`, '=test', 1, 'two', {} as never)).toThrow(
      'Cannot pass [object Object] to Lua',
    )
    expect(() => lua.run(`error('plain')`, '=test')).toThrow(LuaError)
    expect(runtime.exports.fl_gettop(lua.L)).toBe(0)
    expect(lua.dead).toBeUndefined()
  })
})
