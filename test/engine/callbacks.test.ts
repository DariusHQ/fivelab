import { describe, expect, it } from 'vitest'

import { pack, stringOf, type MsgpackObject } from '../../src/core/engine/msgpack.ts'
import { createProcess, type TestProcess } from './helpers.ts'

/** What the scripts of a process printed since it was last asked. */
function scripts(proc: TestProcess): string[] {
  return proc.take().filter((line) => line.startsWith('[script:'))
}

/** The values of an array of strings and integers, as msgpack-c holds them. */
function valuesOf(args: MsgpackObject): unknown[] {
  if (args.type !== 'array') throw new Error('The arguments are no array')
  return args.items.map((item) =>
    item.type === 'positive' || item.type === 'negative' ? Number(item.value) : stringOf(item),
  )
}

describe('Callbacks', () => {
  it('get what scripts call them with, in the resource that calls them', async () => {
    const proc = await createProcess()
    const { manager } = proc
    proc
      .add('a', {
        'main.lua': `AddEventHandler('take', function(cb)
    print('returned', select('#', cb('x', 2)))
end)`,
      })
      .start()
    proc.take()
    const calls: unknown[] = []
    const callback = manager.callbacks.create((args) => {
      calls.push([manager.currentResource?.name, ...valuesOf(args)])
    })
    manager.events.trigger('take', pack([callback]))
    expect(calls).toEqual([['a', 'x', 2]])
    expect(scripts(proc)).toEqual(['[script:a] returned\t0'])
  })

  it('have references from _cfx_internal:0:1 on, packed in extension 11', async () => {
    const proc = await createProcess()
    const decoder = new TextDecoder()
    const [first, second] = [0, 1].map(() => proc.manager.callbacks.create(() => {}))
    expect([first!.type, decoder.decode(first!.data), decoder.decode(second!.data)]).toEqual([
      11,
      '_cfx_internal:0:1',
      '_cfx_internal:0:2',
    ])
  })

  it('go once the last reference that held them is deleted, whatever their instance', async () => {
    const proc = await createProcess()
    let calls = 0
    proc.manager.callbacks.create(() => calls++)
    proc
      .add('a', {
        'main.lua': `local ref = '_cfx_internal:7:1'
local function call() return Citizen.InvokeFunctionReference(ref, msgpack.pack({})) end
print(DuplicateFunctionReference(ref), DuplicateFunctionReference('_cfx_internal:0:1'))
DeleteFunctionReference(ref)
print(#call())
DeleteFunctionReference(ref)
DeleteFunctionReference(ref)
print(call(), DuplicateFunctionReference(ref))
print(pcall(Citizen.InvokeFunctionReference, '_cfx_internal:0:2', msgpack.pack({})))`,
      })
      .start()
    expect(scripts(proc)).toEqual([
      '[script:a] _cfx_internal:1128419924:1\t_cfx_internal:1128419924:1',
      '[script:a] 1',
      '[script:a] nil\tnil',
      '[script:a] true\tnil',
    ])
    expect(calls).toBe(1)
    expect(proc.diagnostics).toEqual([
      'a: DuplicateFunctionReference was given _cfx_internal:7:1, which names no callback that is left: FiveM would return a reference by an index it does not set. FiveRunner returns nil.',
    ])
  })

  it('are what references to _cfx_internal name, even with a resource of that name', async () => {
    const proc = await createProcess()
    const resource = proc.add('_cfx_internal', { 'main.lua': `local keep = function() end` })
    resource.start()
    const ref = `_cfx_internal:${resource.runtime!.host.instanceId}:1`
    expect(proc.manager.lookUpRef(ref)).toBe(undefined)
    expect(proc.manager.invokeFunctionReference(ref, pack([]))).toBe(null)
    proc.add('a', { 'main.lua': `print(DuplicateFunctionReference('nothing:1:1'))` }).start()
    expect(scripts(proc)).toEqual(['[script:a] nil'])
    expect(proc.diagnostics).toEqual([])
  })

  it('go once the scripts that got them let go of them', async () => {
    const proc = await createProcess()
    let calls = 0
    const callback = proc.manager.callbacks.create(() => calls++)
    proc
      .add('a', {
        'main.lua': `AddEventHandler('take', function(cb)
    cb()
end)
AddEventHandler('collect', function()
    collectgarbage()
    collectgarbage()
    print(Citizen.InvokeFunctionReference('_cfx_internal:0:1', msgpack.pack({})))
end)`,
      })
      .start()
    proc.manager.events.trigger('take', pack([callback]))
    proc.manager.events.trigger('collect', pack([]))
    expect(calls).toBe(1)
    expect(scripts(proc)).toEqual(['[script:a] nil'])
  })
})
