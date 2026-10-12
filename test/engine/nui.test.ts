import { describe, expect, it } from 'vitest'

import type { NativeContext } from '../../src/core/engine/index.ts'
import { pack } from '../../src/core/engine/msgpack.ts'
import { defineNative } from '../../src/core/natives/index.ts'
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

describe('NUI callbacks', () => {
  it('are registered with RegisterNuiCallback, which reports their errors', async () => {
    const registered: string[] = []
    const register = defineNative(
      {
        name: 'REGISTER_NUI_CALLBACK',
        result: 'void',
        params: ['char* callbackType', 'func callback'],
      },
      (_ctx: NativeContext, type, callback) => {
        registered.push(`${type} ${callback}`)
      },
    )
    const proc = await createProcess({ side: 'client', natives: [register] })
    start(
      proc,
      'a',
      `RegisterNuiCallback('greet', function(body, cb)
    print('greeted', body.name, cb)
end)
RegisterNuiCallback('fail', function()
    error('broken')
end)`,
    )
    expect(registered).toEqual(['greet a:41:0', 'fail a:41:1'])
    proc.manager.invokeFunctionReference('a:41:0', pack([{ name: 'x' }]))
    proc.manager.invokeFunctionReference('a:41:1', pack([{}]))
    expect(proc.take()).toEqual([
      '[script:a] greeted\tx\tnil',
      '[script:a] error during NUI callback fail: @a/main.lua:5: broken',
    ])
  })

  it('are named callback in stack traces, as in FiveM', async () => {
    const register = defineNative(
      {
        name: 'REGISTER_NUI_CALLBACK',
        result: 'void',
        params: ['char* callbackType', 'func callback'],
      },
      () => {},
    )
    const proc = await createProcess({ side: 'client', natives: [register] })
    start(proc, 'b', `AddEventHandler('fail', function() error('boom') end)`)
    start(
      proc,
      'a',
      `RegisterNuiCallback('notify', function()
    TriggerEvent('fail')
end)`,
    )
    proc.manager.invokeFunctionReference('a:18467:0', pack([{}]))
    expect(proc.take()).toEqual([
      '[script:b] ^1SCRIPT ERROR: @b/main.lua:1: boom^7',
      '[script:b] ^3> callback^7 (^5@a/main.lua^7:2)',
    ])
  })

  it('are events with RegisterNUICallback, which registers their type', async () => {
    const types: string[] = []
    const registerType = defineNative(
      { name: 'REGISTER_NUI_CALLBACK_TYPE', result: 'void', params: ['char* callbackType'] },
      (_ctx: NativeContext, type) => {
        types.push(type!)
      },
    )
    const proc = await createProcess({ side: 'client', natives: [registerType] })
    start(
      proc,
      'a',
      `RegisterNUICallback('greet', function(body, cb)
    cb(body.name .. '!')
end)
RegisterNUICallback('fail', function(body, cb)
    cb(body.missing.name)
end)`,
    )
    expect(types).toEqual(['greet', 'fail'])
    start(
      proc,
      'b',
      `Citizen.GetFunctionReference(function(result)
    print('answered', result)
end)`,
    )
    // NUI requests go only to the resource of the callback, with a function to answer them.
    const a = proc.manager.getResource('a')!
    const answer = [...new TextEncoder().encode('b:18467:0')]
    const request = (body: Uint8Array) =>
      new Uint8Array([0x92, ...body, 0xc7, answer.length, 0x0a, ...answer])
    proc.manager.events.trigger('__cfx_nui:greet', request(pack({ name: 'x' })), '', a)
    proc.manager.events.trigger('__cfx_nui:fail', request(pack({})), '', a)
    expect(proc.take()).toEqual([
      '[script:b] answered\tx!',
      "[script:a] error during NUI callback fail: @a/main.lua:5: attempt to index a nil value (field 'missing')",
    ])
  })

  it('send messages to NUI as JSON with SendNUIMessage', async () => {
    const messages: string[] = []
    const send = defineNative(
      { name: 'SEND_NUI_MESSAGE', result: 'BOOL', params: ['char* jsonString'] },
      (_ctx: NativeContext, json) => {
        messages.push(json!)
        return true
      },
    )
    const proc = await createProcess({ side: 'client', natives: [send] })
    expect(start(proc, 'a', `print(SendNUIMessage({ type = 'open', items = { 1, 2 } }))`)).toEqual([
      '[script:a] ',
    ])
    expect(messages.map((message) => JSON.parse(message) as unknown)).toEqual([
      { type: 'open', items: [1, 2] },
    ])
  })

  it('are only on clients', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `print(RegisterNUICallback, SendNUIMessage, rawget(_G, 'RegisterNuiCallback'))`,
      ),
    ).toEqual(['[script:a] nil\tnil\tnil'])
  })
})
