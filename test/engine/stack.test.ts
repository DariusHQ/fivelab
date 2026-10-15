import { describe, expect, it } from 'vitest'

import { LuaError } from '../../src/core/lua/index.ts'
import { createProcess, type TestProcess } from './helpers.ts'

/** Starts a resource running `source` and returns the lines written but those of every start. */
function start(proc: TestProcess, name: string, source: string): string[] {
  proc.add(name, { 'main.lua': source }).start()
  const starting = [
    `[citizen-scripting-core] Creating script environments for ${name}`,
    `[resources] Started resource ${name}`,
  ]
  return proc.take().filter((line) => !starting.includes(line))
}

/** A handler of `event` that fails at line 2. */
const FAILING = (event: string) => `AddEventHandler('${event}', function()
    error('boom')
end)`

describe('stack traces', () => {
  it('follow SCRIPT ERROR with the frames of the runtimes that called in', async () => {
    const proc = await createProcess()
    start(proc, 'b', FAILING('fail'))
    start(
      proc,
      'a',
      `local function notify()
    TriggerEvent('fail')
end
CreateThread(function()
    notify()
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:b] ^1SCRIPT ERROR: @b/main.lua:2: boom^7',
      '[script:b] ^3> notify^7 (^5@a/main.lua^7:2)',
      '[script:b] ^3> fn^7 (^5@a/main.lua^7:5)',
    ])
  })

  it('show the frames of each runtime that called in, the innermost first', async () => {
    const proc = await createProcess()
    start(proc, 'c', FAILING('second'))
    start(
      proc,
      'b',
      `AddEventHandler('first', function()
    TriggerEvent('second')
end)`,
    )
    start(
      proc,
      'a',
      `CreateThread(function()
    TriggerEvent('first')
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:c] ^1SCRIPT ERROR: @c/main.lua:2: boom^7',
      '[script:c] ^3> handler^7 (^5@b/main.lua^7:2)',
      '[script:c] ^3> fn^7 (^5@a/main.lua^7:2)',
    ])
  })

  it('follow each SCRIPT ERROR, even once a stack trace was formatted', async () => {
    const proc = await createProcess()
    start(proc, 'b', FAILING('fail'))
    start(
      proc,
      'a',
      `CreateThread(function()
    TriggerEvent('fail')
    TriggerEvent('fail')
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:b] ^1SCRIPT ERROR: @b/main.lua:2: boom^7',
      '[script:b] ^3> fn^7 (^5@a/main.lua^7:2)',
      '[script:b] ^1SCRIPT ERROR: @b/main.lua:2: boom^7',
      '[script:b] ^3> fn^7 (^5@a/main.lua^7:3)',
    ])
  })

  it('report a runtime that fails to walk its stack on the console of the current one', async () => {
    const proc = await createProcess()
    start(proc, 'b', FAILING('fail'))
    start(proc, 'a', `CreateThread(function() TriggerEvent('fail') end)`)
    proc.manager.getResource('a')!.runtime!.walkStack = () => {
      throw new LuaError('walk failed', 'runtime', 'stack traceback:\n\t[C]: in ?')
    }
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:b] Error running stack trace function for resource a: walk failed',
      '[script:b] stack traceback:',
      '[script:b] \t[C]: in ?',
      '[script:b] ^1SCRIPT ERROR: @b/main.lua:2: boom^7',
    ])
  })

  it('show no frames of a runtime that called into itself, as FiveM does', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `${FAILING('fail')}
CreateThread(function()
    TriggerEvent('fail')
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] ^1SCRIPT ERROR: @a/main.lua:2: boom^7'])
  })
})

describe('FormatStackTrace', () => {
  it('gives the frames of the script that calls it, its own included', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `CreateThread(function()
    print(FormatStackTrace())
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:a] ^3> FormatStackTrace^7 (^5FormatStackTrace.lua^7:4)',
      '[script:a] ^3> fn^7 (^5@a/main.lua^7:2)',
      '[script:a] ',
    ])
  })

  it('gives nil once a stack trace was formatted, until the outermost call returns', async () => {
    const proc = await createProcess()
    start(proc, 'b', FAILING('fail'))
    start(
      proc,
      'a',
      `CreateThread(function()
    print(FormatStackTrace() ~= nil, FormatStackTrace())
    Wait(0)
    TriggerEvent('fail')
    print(FormatStackTrace())
    Wait(0)
    print(FormatStackTrace() ~= nil)
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] true\tnil'])
    proc.tickAt(1)
    expect(proc.take()).toEqual([
      '[script:b] ^1SCRIPT ERROR: @b/main.lua:2: boom^7',
      '[script:b] ^3> fn^7 (^5@a/main.lua^7:4)',
      '[script:a] nil',
    ])
    proc.tickAt(2)
    expect(proc.take()).toEqual(['[script:a] true'])
  })

  it('shows nothing after the call left the runtime from where it no longer runs, as FiveM does', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `CreateThread(function()
    TriggerEvent('unhandled')
    print(FormatStackTrace() == '')
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] true'])
  })

  it('leaves out the frames it is given, and says so', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `CreateThread(function()
    print(FormatStackTrace({ { name = 'given', file = 'given.lua', line = 1 } }))
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:a] ^3> FormatStackTrace^7 (^5FormatStackTrace.lua^7:4)',
      '[script:a] ^3> fn^7 (^5@a/main.lua^7:2)',
      '[script:a] ',
    ])
    expect(proc.diagnostics).toEqual([
      'a: FormatStackTrace was given stack frames to put first, which FiveRunner does not read yet: it leaves them out of the stack trace.',
    ])
  })
})
