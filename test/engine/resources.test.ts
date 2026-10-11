import { describe, expect, it } from 'vitest'

import type { NativeContext } from '../../src/core/engine/index.ts'
import { defineNative } from '../../src/core/natives/index.ts'
import { createProcess } from './helpers.ts'

describe('resources', () => {
  it('run their shared scripts, then those of their side, when they start', async () => {
    const proc = await createProcess({ side: 'client' })
    const res = proc.add(
      'a',
      {
        'client.lua': `print('client')`,
        'server.lua': `print('server')`,
        'shared.lua': `print('shared')`,
      },
      [
        ['client_script', 'client.lua'],
        ['server_script', 'server.lua'],
        ['shared_script', 'shared.lua'],
      ],
    )
    expect(res.state).toBe('stopped')
    expect(res.start()).toBe(true)
    expect(res.state).toBe('started')
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] shared',
      '[script:a] client',
    ])
  })

  it('report scripts that do not load, and go on with the others', async () => {
    const proc = await createProcess()
    proc
      .add('a', { 'broken.lua': `local = 1`, 'ok.lua': `print('ok')` }, [
        ['server_script', 'missing.lua'],
        ['server_script', 'broken.lua'],
        ['server_script', 'ok.lua'],
      ])
      .start()
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[citizen-scripting-core] Failed to load script missing.lua.',
      "[script:a] Error parsing script @a/broken.lua in resource a: @a/broken.lua:1: <name> expected near '='",
      '[citizen-scripting-core] Failed to load script broken.lua.',
      '[script:a] ok',
    ])
  })

  it('have no runtime without Lua scripts, and say which scripts FiveLab skips', async () => {
    const proc = await createProcess()
    const res = proc.add('a', { 'server.js': `console.log('js')` })
    res.start()
    expect(res.runtime).toBe(null)
    expect(proc.take()).toEqual([])
    expect(proc.diagnostics).toEqual(['a: FiveLab runs only Lua scripts, so it skips server.js.'])
  })

  it('stop their threads when they stop', async () => {
    const proc = await createProcess()
    const res = proc.add('a', {
      'server.lua': `CreateThread(function() while true do print('tick') Wait(0) end end)`,
    })
    res.start()
    proc.take()
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] tick'])
    expect(res.stop()).toBe(true)
    expect(res.state).toBe('stopped')
    expect(res.runtime).toBe(null)
    proc.tickAt(1)
    expect(proc.take()).toEqual([])
  })

  it('close their runtime only once the call that stopped them returns', async () => {
    const stop = defineNative(
      { name: 'STOP_THIS_RESOURCE', result: 'void', params: [] },
      (ctx: NativeContext) => {
        ctx.resource.stop()
      },
    )
    const proc = await createProcess({ natives: [stop] })
    const res = proc.add('a', {
      'first.lua': `StopThisResource()
print('still running', GetCurrentResourceName())
CreateThread(function() print('never runs') end)`,
      'second.lua': `print('never loads')`,
    })
    res.start()
    // FiveM marks the resource started once it is done starting it, stopped or not.
    expect(res.state).toBe('started')
    expect(res.runtime).toBe(null)
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] still running\ta',
    ])
  })
})

describe('ticks', () => {
  it('resume threads in the order the runtimes were created, as in FiveM', async () => {
    const proc = await createProcess()
    const loop = (name: string) => ({
      'server.lua': `CreateThread(function() while true do print('${name}') Wait(0) end end)`,
    })
    const a = proc.add('a', loop('a'))
    const b = proc.add('b', loop('b'))
    a.start()
    b.start()
    proc.take()
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] a', '[script:b] b'])
    a.stop()
    a.start()
    proc.take()
    proc.tickAt(1)
    expect(proc.take()).toEqual(['[script:b] b', '[script:a] a'])
  })
})

describe('scripting natives', () => {
  it('name the current resource, and the invoking one only when another called in', async () => {
    const proc = await createProcess()
    proc
      .add('a', {
        'server.lua': `print(GetCurrentResourceName(), GetInvokingResource())
CreateThread(function() print(GetCurrentResourceName(), GetInvokingResource()) end)`,
      })
      .start()
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] a\tnil',
      '[script:a] a\tnil',
    ])
  })

  it('tell the server from clients', async () => {
    // Like other BOOL natives, IsDuplicityVersion returns 1 or false to Lua.
    for (const [side, duplicity] of [
      ['server', '1'],
      ['client', 'false'],
    ] as const) {
      const proc = await createProcess({ side })
      proc.add('a', { 'main.lua': `print(IsDuplicityVersion())` }).start()
      expect(proc.take()[1]).toBe(`[script:a] ${duplicity}`)
    }
  })

  it('count milliseconds since the process started: as an int on clients, a long on servers', async () => {
    for (const [side, timer] of [
      ['client', -(2 ** 31) + 5],
      ['server', 2 ** 31 + 5],
    ] as const) {
      const proc = await createProcess({ side })
      proc.time = 2 ** 31 + 5.75
      proc.add('a', { 'main.lua': `print(GetGameTimer(), math.type(GetGameTimer()))` }).start()
      expect(proc.take()[1]).toBe(`[script:a] ${timer}\tinteger`)
    }
  })
})
