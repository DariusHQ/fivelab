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
