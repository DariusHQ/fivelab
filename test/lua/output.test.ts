import { afterEach, describe, expect, it, vi } from 'vitest'

import { LuaRuntime } from '../../src/core/lua/index.ts'
import { cfxlua, createRuntime, thrown } from './helpers.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('output', () => {
  it('passes what the module writes to the output handler', async () => {
    const chunks: string[] = []
    const runtime = await createRuntime({ output: (stream, text) => chunks.push(stream, text) })
    runtime.newState().run(`print('a', 1) print('b')`, '=test')
    expect(chunks).toEqual(['stdout', 'a\t1\n', 'stdout', 'b\n'])
  })

  it('prints whole lines to the console by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = await LuaRuntime.create(await cfxlua())
    runtime.newState().run(`print('a', 1) print('b')`, '=test')
    expect(log.mock.calls).toEqual([['a\t1'], ['b']])
  })
})

describe('warnings', () => {
  it('reach the state handler whole, control messages included', async () => {
    const warnings: string[] = []
    const lua = (await createRuntime()).newState({ onWarning: (message) => warnings.push(message) })
    lua.run(`warn('one ', 'message') warn('@on')`, '=test')
    expect(warnings).toEqual(['one message', '@on'])
  })

  it('report errors in finalizers', async () => {
    const warnings: string[] = []
    const lua = (await createRuntime()).newState({ onWarning: (message) => warnings.push(message) })
    lua.run(`setmetatable({}, {__gc = function() error('boom') end}) collectgarbage()`, '=test')
    expect(warnings).toEqual(['error in __gc (test:1: boom)'])
  })

  it('go to stderr by default', async () => {
    const chunks: string[] = []
    const runtime = await createRuntime({ output: (stream, text) => chunks.push(stream, text) })
    runtime.newState().run(`warn('careful')`, '=test')
    expect(chunks).toEqual(['stderr', 'Lua warning: careful\n'])
  })

  it('cannot call back into Lua from their handler', async () => {
    const runtime = await createRuntime()
    const errors: unknown[] = []
    const lua = runtime.newState({
      onWarning: () => {
        errors.push(thrown(() => lua.run(`return 1`, '=nested')))
        errors.push(thrown(() => runtime.newState()))
      },
    })
    lua.run(`warn('x')`, '=test')
    expect(errors).toEqual([
      new Error('Cannot call into Lua from an output or warning handler'),
      new Error('Cannot call into Lua from an output or warning handler'),
    ])
    expect(lua.run(`return 'alive'`, '=test')).toEqual(['alive'])
  })

  it('report what a handler throws without unwinding Lua', async () => {
    const lua = (await createRuntime()).newState({
      onWarning: () => {
        throw new Error('handler failed')
      },
    })
    const scheduled: (() => void)[] = []
    const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      scheduled.push(callback)
    })
    const results = lua.run(`warn('x') return 'alive'`, '=test')
    queue.mockRestore()
    expect(results).toEqual(['alive'])
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]).toThrow('handler failed')
  })
})
