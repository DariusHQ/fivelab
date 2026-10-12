import { describe, expect, it } from 'vitest'

import type { MetadataEntry } from '../../src/core/engine/index.ts'
import { createProcess, type TestProcess } from './helpers.ts'

/** Starts a resource running `source` and returns the lines written but those of every start. */
function start(
  proc: TestProcess,
  name: string,
  source: string,
  metadata?: readonly MetadataEntry[],
): string[] {
  proc
    .add(name, { 'main.lua': source }, metadata && [...metadata, ['server_script', 'main.lua']])
    .start()
  const starting = [
    `[citizen-scripting-core] Creating script environments for ${name}`,
    `[resources] Started resource ${name}`,
  ]
  return proc.take().filter((line) => !starting.includes(line))
}

describe('function references', () => {
  it('name functions of a runtime as resource:instance:index, counting from 0', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `print(Citizen.GetFunctionReference(print), Citizen.GetFunctionReference(function() end))
print(Citizen.GetFunctionReference(42), Citizen.GetFunctionReference({}))`,
      ),
    ).toEqual(['[script:a] a:41:0\ta:41:1', '[script:a] nil\tnil'])
  })

  it('format indices as integers of 32 bits with Citizen.CanonicalizeRef', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `print(Citizen.CanonicalizeRef(2^32 + 5), Citizen.CanonicalizeRef('-1'))
print(pcall(Citizen.CanonicalizeRef, 1.5))`,
      ),
    ).toEqual([
      '[script:a] a:41:5\ta:41:-1',
      "[script:a] false\tbad argument #1 to '?' (number has no integer representation)",
    ])
  })

  it('count the holders that duplicate them, and forget them once none is left', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `local ref = Citizen.GetFunctionReference(function() end)
print(DuplicateFunctionReference(ref), DuplicateFunctionReference(ref))
DeleteFunctionReference(ref)
print(DuplicateFunctionReference(ref))
DeleteFunctionReference(ref)
DeleteFunctionReference(ref)
print(DuplicateFunctionReference(ref))
local unheld = Citizen.GetFunctionReference(print)
DeleteFunctionReference(unheld)
print(DuplicateFunctionReference(unheld))`,
      ),
    ).toEqual([
      '[script:a] a:41:0\ta:41:0',
      '[script:a] a:41:0',
      '[script:a] a:41:-1',
      '[script:a] a:41:-1',
    ])
  })

  it('are looked up by their resource, or one that provides it, and its runtime', async () => {
    const proc = await createProcess()
    start(proc, 'a', `Citizen.GetFunctionReference(print)`)
    start(proc, 'c', `Citizen.GetFunctionReference(print)`, [['provide', 'old']])
    start(proc, 'stopped', `Citizen.GetFunctionReference(print)`)
    proc.manager.getResource('stopped')!.stop()
    proc.take()
    expect(
      start(
        proc,
        'b',
        `print(DuplicateFunctionReference('a:41:0'), DuplicateFunctionReference('old:18467:0'))
print(DuplicateFunctionReference('a:42:0'), DuplicateFunctionReference('missing:41:0'),
    DuplicateFunctionReference('stopped:6334:0'), DuplicateFunctionReference('_cfx_internal:0:0'))
print(DuplicateFunctionReference('a:41'), DuplicateFunctionReference('a:41:x'), DuplicateFunctionReference('a'))`,
      ),
    ).toEqual([
      '[script:b] a:41:0\tc:18467:0',
      '[script:b] nil\tnil\tnil\tnil',
      '[script:b] a:41:0\ta:41:0\tnil',
    ])
  })

  it('are not nil, for which FiveM has no defined behavior', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `print(DuplicateFunctionReference(nil))
DeleteFunctionReference(nil)`,
      ),
    ).toEqual(['[script:a] nil'])
    expect(proc.diagnostics).toEqual([
      'a: DuplicateFunctionReference was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveLab returns nil.',
      'a: DeleteFunctionReference was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveLab does nothing.',
    ])
  })
})

describe('proxies', () => {
  it('are what msgpack packs functions as, by reference in extension 10', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `print(msgpack.pack(print, { f = print }) == '\\xc7\\x06\\x0aa:41:0\\x81\\xa1f\\xc7\\x06\\x0aa:41:1')
local proxy = msgpack.unpack('\\xc7\\x06\\x0aa:41:0')
print(type(proxy), rawget(proxy, '__cfx_functionReference'))
print(rawget(msgpack.unpack('\\xc7\\x06\\x0bx:41:0'), '__cfx_functionReference'))`,
      ),
    ).toEqual(['[script:a] true', '[script:a] table\ta:41:0', '[script:a] x:41:0'])
  })

  it('hold the references they unpack until they are collected', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `local proxy = msgpack.unpack(msgpack.pack(function() end))
print(DuplicateFunctionReference('a:41:0'))
DeleteFunctionReference('a:41:0')
print(DuplicateFunctionReference('a:41:0'))
DeleteFunctionReference('a:41:0')
proxy = nil
collectgarbage()
print(DuplicateFunctionReference('a:41:0'))`,
      ),
    ).toEqual(['[script:a] a:41:0', '[script:a] a:41:0', '[script:a] a:41:-1'])
  })

  it('cannot be indexed', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `local proxy = msgpack.unpack(msgpack.pack(print))
print(pcall(function() return proxy.x end))
print(pcall(function() proxy.x = 1 end))`,
      ),
    ).toEqual([
      '[script:a] false\t@a/main.lua:2: Cannot index a funcref',
      '[script:a] false\t@a/main.lua:3: Cannot set indexes on a funcref',
    ])
  })

  it('pack as references of their own, to a function that calls them', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `local proxy = msgpack.unpack(msgpack.pack(print))
print(rawget(msgpack.unpack(msgpack.pack(proxy)), '__cfx_functionReference'))
local unreferenced = setmetatable({}, getmetatable(proxy))
print(pcall(msgpack.pack, unreferenced))
unreferenced = nil
collectgarbage()`,
      ),
    ).toEqual(['[script:a] a:41:1', '[script:a] false\tUnknown funcref type: 10 table'])
    // The proxy that names no reference deletes nil once it is collected.
    expect(proc.diagnostics).toEqual([
      'a: DeleteFunctionReference was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveLab does nothing.',
    ])
  })
})
