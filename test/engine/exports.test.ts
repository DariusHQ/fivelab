import { describe, expect, it } from 'vitest'

import type { ResourceDefinition } from '../../src/core/engine/index.ts'
import { pack } from '../../src/core/engine/msgpack.ts'
import { createProcess, type TestProcess } from './helpers.ts'

/** Starts a resource with `files` and returns the lines written but those of every start. */
function start(proc: TestProcess, name: string, files: ResourceDefinition['files']): string[] {
  proc.add(name, files).start()
  const starting = [
    `[citizen-scripting-core] Creating script environments for ${name}`,
    `[resources] Started resource ${name}`,
  ]
  return proc.take().filter((line) => !starting.includes(line))
}

const NO_ARGUMENTS = pack([])

describe('exports', () => {
  it('call the functions that resources export, which the caller invokes', async () => {
    const proc = await createProcess()
    start(proc, 'a', {
      'main.lua': `exports('add', function(x, y)
    print('adding', GetCurrentResourceName(), GetInvokingResource())
    return x + y, 'sum'
end)`,
    })
    // Called with a dot, an export takes its first argument as the table.
    expect(
      start(proc, 'b', {
        'main.lua': `print(exports.a:add(2, 3))
print(exports.a.add(nil, 4, 5))`,
      }),
    ).toEqual([
      '[script:a] adding\ta\tb',
      '[script:b] 5\tsum',
      '[script:a] adding\ta\tb',
      '[script:b] 9\tsum',
    ])
  })

  it('give the globals that manifests export on their side, as they are when asked for', async () => {
    const proc = await createProcess()
    expect(
      start(proc, 'a', {
        'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'
server_exports { 'mul', 'later' }
exports { 'onClients' }`,
        'main.lua': `function mul(x, y) return x * y end
function onClients() end
CreateThread(function()
    function later() return 'defined' end
end)
-- FiveM adds the handlers of the manifest's exports after that of HTTP responses.
print(AddEventHandler('x', print).key)`,
      }),
    ).toEqual(['[script:a] 14'])
    expect(
      start(proc, 'b', {
        'main.lua': `print(exports.a:mul(2, 3))
print(pcall(function() return exports.a.later end))
print(pcall(function() return exports.a.onClients end))
AddEventHandler('ask', function()
    print(exports.a:later())
end)`,
      }),
    ).toEqual([
      '[script:b] 6',
      '[script:b] false\t@b/main.lua:2: No such export later in resource a',
      '[script:b] false\t@b/main.lua:3: No such export onClients in resource a',
    ])
    proc.tickAt(0)
    proc.manager.events.trigger('ask', NO_ARGUMENTS)
    expect(proc.take()).toEqual(['[script:b] defined'])
  })

  it('fail for exports that are missing, names that are no strings, and changes', async () => {
    const proc = await createProcess()
    expect(
      start(proc, 'a', {
        'main.lua': `print(pcall(function() return exports.missing.x end))
print(pcall(function() return exports.a[1] end))
print(pcall(function() exports.a = {} end))
print(pcall(function() exports.a.x = print end))`,
      }),
    ).toEqual([
      '[script:a] false\t@a/main.lua:1: No such export x in resource missing',
      '[script:a] false\t@a/main.lua:2: Invalid export name: 1',
      '[script:a] false\t@a/main.lua:3: cannot set values on exports',
      '[script:a] false\t@a/main.lua:4: cannot set values on an export resource',
    ])
  })

  it('keep the functions they get until a resource stops', async () => {
    const proc = await createProcess()
    start(proc, 'a', { 'main.lua': `exports('add', function(x, y) return x + y end)` })
    start(proc, 'watcher', {
      'main.lua': `AddEventHandler('__cfx_export_a_add', function()
    print('asked')
end)`,
    })
    // b asks for the export once, which both a and the watcher handle.
    expect(
      start(proc, 'b', {
        'main.lua': `local add = exports.a.add
print(exports.a:add(1, 1), add(nil, 2, 2))
AddEventHandler('later', function()
    print(pcall(add, nil, 3, 3))
end)`,
      }),
    ).toEqual(['[script:watcher] asked', '[script:b] 2\t4'])
    proc.manager.getResource('a')!.stop()
    proc.take()
    const failure = (reason: string) => [
      '[script:b] false\t',
      '[script:b] ^5 An error occurred while calling export `add` in resource `a`:',
      `[script:b]   ${reason}`,
      '[script:b] ^5 ---',
    ]
    // b keeps the proxy until onServerResourceStop comes, at the next tick.
    proc.manager.events.trigger('later', NO_ARGUMENTS)
    expect(proc.take()).toEqual(failure('Execution of function reference in script host failed: '))
    proc.tickAt(0)
    proc.manager.events.trigger('later', NO_ARGUMENTS)
    expect(proc.take()).toEqual(failure('attempt to call a nil value'))
  })

  it('await exports that wait, and cut the errors that are long short', async () => {
    const proc = await createProcess()
    start(proc, 'a', {
      'main.lua': `exports('slow', function(n)
    Wait(10)
    if n then return n * 2 end
    error(string.rep('x', 3000))
end)`,
    })
    start(proc, 'b', {
      'main.lua': `CreateThread(function()
    print('doubled', exports.a:slow(21))
    local ok, err = pcall(function() exports.a:slow() end)
    print(ok, err)
end)`,
    })
    proc.tickAt(0)
    proc.tickAt(10)
    expect(proc.take()).toEqual(['[script:b] doubled\t42'])
    proc.tickAt(20)
    const lines = proc.take()
    // The error that Citizen.Await raises, from where the proxy awaits it.
    const stack = '^7\n^3> ref^7 (^5@a/main.lua^7:4)\n'
    const head = lines[2]!.slice('[script:b]   '.length)
    expect(head).toMatch(/^fivelab:\/refs\.lua:\d+: \^1SCRIPT ERROR: @a\/main\.lua:4: x+$/)
    expect(head).toHaveLength(1024)
    expect(lines).toEqual([
      // The export was called from a function that does not tail call it.
      '[script:b] false\t@b/main.lua:3: ',
      '[script:b] ^5 An error occurred while calling export `slow` in resource `a`:',
      `[script:b]   ${head}`,
      '[script:b]   ... [large output partially truncated] ...',
      `[script:b]   ${'x'.repeat(1024 - stack.length)}^7`,
      '[script:b]   ^3> ref^7 (^5@a/main.lua^7:4)',
      '[script:b] ',
      '[script:b] ^5 ---',
    ])
  })

  it('give those of monitor for txAdmin, as FiveM does', async () => {
    const proc = await createProcess()
    start(proc, 'monitor', { 'main.lua': `exports('version', function() return '8.0' end)` })
    expect(
      start(proc, 'b', {
        'main.lua': `print(exports.txAdmin:version(), exports.monitor:version())`,
      }),
    ).toEqual(['[script:b] 8.0\t8.0'])
  })
})
