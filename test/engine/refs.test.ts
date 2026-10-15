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
      'a: DuplicateFunctionReference was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveRunner returns nil.',
      'a: DeleteFunctionReference was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveRunner does nothing.',
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
      'a: DeleteFunctionReference was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveRunner does nothing.',
    ])
  })
})

describe('calls by reference', () => {
  it('call functions of other runtimes, which the caller invokes', async () => {
    const proc = await createProcess()
    start(
      proc,
      'b',
      `AddEventHandler('call', function(add)
    print(add(2, 3))
    TriggerEvent('back', add)
end)`,
    )
    expect(
      start(
        proc,
        'a',
        `AddEventHandler('back', function(add)
    print(add(10, 20))
end)
TriggerEvent('call', function(x, y)
    print(GetCurrentResourceName(), GetInvokingResource())
    return x + y, 'sum'
end)`,
      ),
    ).toEqual([
      '[script:a] a\tb',
      '[script:b] 5\tsum',
      // b passed the function on through one of its own, which calls it.
      '[script:a] a\tb',
      '[script:a] 30\tsum',
    ])
  })

  it('report errors of the functions they call, which then return nothing', async () => {
    const proc = await createProcess()
    start(
      proc,
      'b',
      `AddEventHandler('call', function(failing)
    print(pcall(failing))
end)`,
    )
    expect(
      start(
        proc,
        'a',
        `local function inner()
    error('broken')
end
TriggerEvent('call', function()
    inner()
end)`,
      ),
    ).toEqual([
      '[script:a] ^1SCRIPT ERROR: @a/main.lua:2: broken^7',
      '[script:a] ^3> inner^7 (^5@a/main.lua^7:2)',
      '[script:a] ^3> ref^7 (^5@a/main.lua^7:5)',
      '[script:a] ^3> handler^7 (^5@b/main.lua^7:2)',
      '[script:b] false\tnil',
    ])
  })

  it('report errors of the routine that calls them, which then gives nil', async () => {
    const proc = await createProcess()
    start(
      proc,
      'b',
      `AddEventHandler('call', function(fn)
    print(pcall(fn))
end)`,
    )
    // The function returns what msgpack cannot pack.
    const lines = start(
      proc,
      'a',
      `local proxy = getmetatable(msgpack.unpack(msgpack.pack(print)))
TriggerEvent('call', function()
    return setmetatable({}, proxy)
end)`,
    )
    expect(lines.slice(0, 2)).toEqual([
      '[script:a] Error running call reference function for resource a: Unknown funcref type: 10 table',
      '[script:a] stack traceback:',
    ])
    // The routine runs on the main thread, as in FiveM, not in the thread that called out.
    expect(lines.filter((line) => line.includes('main.lua'))).toEqual([])
    expect(lines.at(-1)).toMatch(
      /^\[script:b\] false\tfiverunner:\/refs\.lua:\d+: bad argument #1 to 'msgpack_unpack' \(string expected, got nil\)$/,
    )
  })

  it('fail for references that name no function', async () => {
    const proc = await createProcess()
    start(
      proc,
      'b',
      `AddEventHandler('keep', function(fn)
    kept = fn
end)
AddEventHandler('later', function()
    print(pcall(kept))
end)`,
    )
    expect(
      start(
        proc,
        'a',
        `print(select('#', Citizen.InvokeFunctionReference('a:18467:7', msgpack.pack_args())))
print(pcall(Citizen.InvokeFunctionReference, 'missing:41:0', ''))
TriggerEvent('keep', print)`,
      ),
    ).toEqual([
      '[script:a] Invalid ref call attempt: 7',
      '[script:a] 1',
      '[script:a] false\tExecution of function reference in script host failed: ',
    ])
    proc.manager.getResource('a')!.stop()
    proc.take()
    proc.manager.events.trigger('later', new Uint8Array([0x90]))
    expect(proc.take()).toEqual([
      '[script:b] false\tExecution of function reference in script host failed: ',
    ])
  })

  it('check the arguments of Citizen.InvokeFunctionReference as FiveM does', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `local ref = Citizen.GetFunctionReference(function(...) return select('#', ...) end)
print(table.unpack(msgpack.unpack(Citizen.InvokeFunctionReference(ref, msgpack.pack_args(1, 2)))))
print(pcall(Citizen.InvokeFunctionReference))
print(pcall(Citizen.InvokeFunctionReference, ref))
print(pcall(Citizen.InvokeFunctionReference, {}, ''))`,
      ),
    ).toEqual([
      '[script:a] 2',
      "[script:a] false\tbad argument #2 to '?' (string expected, got no value)",
      "[script:a] false\tbad argument #2 to '?' (string expected, got no value)",
      "[script:a] false\tbad argument #1 to '?' (string expected, got table)",
    ])
  })

  it('queue the threads the functions create once the call returns', async () => {
    const proc = await createProcess()
    start(
      proc,
      'b',
      `AddEventHandler('keep', function(fn)
    kept = fn
end)
AddEventHandler('later', function()
    kept()
end)`,
    )
    start(
      proc,
      'a',
      `TriggerEvent('keep', function()
    CreateThread(function()
        print('created')
    end)
end)`,
    )
    proc.manager.events.trigger('later', new Uint8Array([0x90]))
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] created'])
  })

  it('await functions that wait, in the thread that calls them', async () => {
    const proc = await createProcess()
    start(
      proc,
      'b',
      `AddEventHandler('call', function(slow)
    print('returned', slow(5))
end)`,
    )
    start(
      proc,
      'a',
      `CreateThread(function()
    TriggerEvent('call', function(n)
        Wait(100)
        return n + 1, 'later'
    end)
    print('triggered')
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] triggered'])
    proc.tickAt(50)
    expect(proc.take()).toEqual([])
    proc.tickAt(100)
    expect(proc.take()).toEqual(['[script:b] returned\t6\tlater'])
  })

  it('raise errors of functions that fail after they waited in the thread that awaits them', async () => {
    const proc = await createProcess()
    start(
      proc,
      'b',
      `AddEventHandler('call', function(slow)
    local ok, err = pcall(slow)
    print(ok, err)
end)`,
    )
    start(
      proc,
      'a',
      `TriggerEvent('call', function()
    Wait(0)
    error('late')
end)`,
    )
    proc.tickAt(0)
    const [first, ...rest] = proc.take()
    // Citizen.Await raises the error from where the proxy awaits it.
    expect(first).toMatch(
      /^\[script:b\] false\tfiverunner:\/refs\.lua:\d+: \^1SCRIPT ERROR: @a\/main\.lua:3: late\^7$/,
    )
    // The stack trace ends the error with a line break, after which print ends the line.
    expect(rest).toEqual(['[script:b] ^3> ref^7 (^5@a/main.lua^7:3)', '[script:b] '])
  })

  it('report errors of functions that fail after they waited when no thread awaits them', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `local ref = Citizen.GetFunctionReference(function()
    Wait(0)
    error('late')
end)
local results = msgpack.unpack(Citizen.InvokeFunctionReference(ref, msgpack.pack_args()))
print(type(rawget(results[1], '__cfx_async_retval')))`,
      ),
    ).toEqual(['[script:a] table'])
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:a] ^1SCRIPT ERROR: @a/main.lua:3: late^7',
      '[script:a] ^3> ref^7 (^5@a/main.lua^7:3)',
    ])
  })
})
