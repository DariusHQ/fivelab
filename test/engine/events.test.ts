import { describe, expect, it } from 'vitest'

import type { NativeContext } from '../../src/core/engine/index.ts'
import { pack } from '../../src/core/engine/msgpack.ts'
import {
  defineNative,
  type NativeDefinition,
  type ParamSpec,
} from '../../src/core/natives/index.ts'
import { createProcess, type TestProcess } from './helpers.ts'

/** msgpack bytes: an array holding the integer 5, nil, and a byte no msgpack value starts with. */
const FIVE = new Uint8Array([0x91, 0x05])
const NIL = new Uint8Array([0xc0])
const INVALID = new Uint8Array([0xc1])

/** Starts a resource running `source` and returns the lines written but those of every start. */
function start(proc: TestProcess, name: string, source: string): string[] {
  proc.add(name, { 'main.lua': source }).start()
  const starting = [
    `[citizen-scripting-core] Creating script environments for ${name}`,
    `[resources] Started resource ${name}`,
  ]
  return proc.take().filter((line) => !starting.includes(line))
}

/** Natives that record the values they are given, bytes as lists of numbers. */
function recorder(names: readonly [string, readonly ParamSpec[]][]): {
  readonly calls: string[]
  readonly natives: NativeDefinition<NativeContext>[]
} {
  const calls: string[] = []
  const natives = names.map(([name, params]) =>
    defineNative({ name, result: 'void', params }, (_ctx: NativeContext, ...values: unknown[]) => {
      const shown = values.map((value) =>
        value instanceof Uint8Array ? `[${Array.from(value).join(',')}]` : String(value),
      )
      calls.push(`${name} ${shown.join(' ')}`)
    }),
  )
  return { calls, natives }
}

describe('TriggerEvent', () => {
  it('runs each handler at once, in a thread of its own', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `AddEventHandler('greet', function(name, n)
    print('hello', name, n)
    Wait(0)
    print('later')
end)
TriggerEvent('greet', 'world', 42)
print('after')`,
      ),
    ).toEqual(['[script:a] hello\tworld\t42', '[script:a] after'])
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] later'])
  })

  it('returns 2146290430, or false when a handler cancels, as FiveM does', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `AddEventHandler('kept', function() end)
AddEventHandler('dropped', function() CancelEvent() end)
print(TriggerEvent('kept'), WasEventCanceled())
print(TriggerEvent('dropped'), WasEventCanceled())
print(TriggerEvent('unhandled'))`,
      ),
    ).toEqual(['[script:a] 2146290430\tfalse', '[script:a] false\t1', '[script:a] 2146290430'])
  })

  it('lets CancelEvent cancel only the innermost event', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `AddEventHandler('outer', function()
    TriggerEvent('inner')
    print('inner canceled', WasEventCanceled())
end)
AddEventHandler('inner', function() CancelEvent() end)
print(TriggerEvent('outer'), WasEventCanceled())`,
      ),
    ).toEqual(['[script:a] inner canceled\t1', '[script:a] 2146290430\tfalse'])
  })

  it('fails without a name', async () => {
    const proc = await createProcess()
    expect(start(proc, 'a', `print(pcall(TriggerEvent, nil))`)).toEqual([
      '[citizen-scripting-core] script error in native 0000000091310870: Argument at index 0 was null.',
      '[script:a] false\tnative 0000000091310870: Argument at index 0 was null.',
    ])
  })
})

describe('event handlers', () => {
  it('run in the order pairs gives their keys, as in FiveM, and can be removed', async () => {
    const proc = await createProcess({ side: 'client' })
    expect(
      start(
        proc,
        'a',
        `local first = AddEventHandler('x', function() print('first') end)
AddEventHandler('x', function() print('second') end)
AddEventHandler('x', function() print('third') end)
TriggerEvent('x')
RemoveEventHandler(first)
TriggerEvent('x')
print(first.key, first.name)
print(pcall(RemoveEventHandler, {}))`,
      ),
    ).toEqual([
      // Keys 11, 12 and 13 sit in the hash part of the table, where pairs finds 11 last.
      '[script:a] second',
      '[script:a] third',
      '[script:a] first',
      '[script:a] second',
      '[script:a] third',
      '[script:a] 11\tx',
      '[script:a] false\tInvalid event data passed to RemoveEventHandler()',
    ])
  })

  it('come after the handler of HTTP responses on servers, as in FiveM', async () => {
    const proc = await createProcess()
    expect(start(proc, 'a', `print(AddEventHandler('x', print).key)`)).toEqual(['[script:a] 12'])
  })

  it('may be tables with __call, and are skipped when they are not functions', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `AddEventHandler('x', setmetatable({}, { __call = function(self, n) print('called', n) end }))
AddEventHandler('x', 'not a function')
AddEventHandler('x', nil)
TriggerEvent('x', 1)`,
      ),
    ).toEqual(['[script:a] called\t1'])
  })

  it('report their errors, and the others still run', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `AddEventHandler('x', function() error('boom') end)
AddEventHandler('x', function() print('still runs') end)
TriggerEvent('x')`,
      ),
    ).toEqual(['[script:a] ^1SCRIPT ERROR: @a/main.lua:1: boom^7', '[script:a] still runs'])
  })

  it('run for payloads of nil, but not for payloads that are no table', async () => {
    const proc = await createProcess()
    start(proc, 'a', `AddEventHandler('x', function(...) print('ran', select('#', ...)) end)`)
    proc.manager.events.trigger('x', NIL)
    proc.manager.events.trigger('x', new Uint8Array([0x05]))
    proc.manager.events.trigger('x', FIVE)
    expect(proc.take()).toEqual(['[script:a] ran\t0', '[script:a] ran\t1'])
  })

  it('are not reached by payloads that do not unpack, which the resource reports', async () => {
    const proc = await createProcess()
    start(proc, 'a', `AddEventHandler('x', function() print('ran') end)`)
    proc.manager.events.trigger('x', INVALID)
    const [report] = proc.take()
    expect(report).toMatch(
      /^\[script:a\] Error running system event handling function for resource a: /,
    )
  })
})

describe('event sources', () => {
  it('are empty strings for events of the process', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `AddEventHandler('x', function() print(type(source), #source) end)
TriggerEvent('x')
print(source)`,
      ),
    ).toEqual(['[script:a] string\t0', '[script:a] nil'])
  })

  it('give the player of net events while handlers start', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `RegisterNetEvent('fromPlayer', function(n)
    print('from', source, n)
    TriggerEvent('nested')
    print('back', source)
    Wait(0)
    print('after waiting', source)
end)
AddEventHandler('nested', function() print('nested', source) end)`,
    )
    proc.manager.events.trigger('fromPlayer', FIVE, 'net:7')
    proc.manager.events.trigger('fromPlayer', FIVE, 'internal-net:3')
    proc.tickAt(0)
    expect(proc.take()).toEqual([
      '[script:a] from\t7\t5',
      '[script:a] nested\t',
      '[script:a] back\t7',
      '[script:a] from\t3\t5',
      '[script:a] nested\t',
      '[script:a] back\t3',
      '[script:a] after waiting\tnil',
      '[script:a] after waiting\tnil',
    ])
  })

  it('keep net events from handlers of events not safe for net', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `AddEventHandler('local', function() print('ran') end)
RegisterNetEvent('__cfx_internal:commandFallback', function() print('ran') end)`,
    )
    proc.manager.events.trigger('local', FIVE, 'net:7')
    proc.manager.events.trigger('__cfx_internal:commandFallback', FIVE, 'net:7')
    proc.manager.log('test', '\n')
    expect(proc.take()).toEqual([
      '[script:a] event local was not safe for net',
      '[script:a] event __cfx_internal:commandFallback was not safe for net',
      '[test] ',
    ])
  })

  it('are internal-net ones only on servers', async () => {
    const proc = await createProcess({ side: 'client' })
    start(proc, 'a', `AddEventHandler('x', function() print(source) end)`)
    proc.manager.events.trigger('x', FIVE, 'internal-net:3')
    expect(proc.take()).toEqual(['[script:a] internal-net:3'])
  })
})

describe('resources getting events', () => {
  it('get them newest registration first, those of "*" before the others', async () => {
    const proc = await createProcess()
    start(proc, 'a', `AddEventHandler('x', function() print('a') end)`)
    start(proc, 'b', `AddEventHandler('x', function() print('b') end)`)
    // Lua handlers of "*" run only for an event of that name, but the
    // resource gets every event, so its handlers of x run twice.
    start(
      proc,
      'c',
      `AddEventHandler('*', function() print('star') end)
AddEventHandler('x', function() print('c') end)`,
    )
    expect(start(proc, 'd', `TriggerEvent('x')`)).toEqual([
      '[script:c] c',
      '[script:c] c',
      '[script:b] b',
      '[script:a] a',
    ])
  })

  it('keep their place across restarts, as FiveM keeps registrations', async () => {
    const proc = await createProcess()
    const a = proc.add('a', { 'main.lua': `AddEventHandler('x', function() print('a') end)` })
    const b = proc.add('b', { 'main.lua': `AddEventHandler('x', function() print('b') end)` })
    a.start()
    b.start()
    a.stop()
    a.start()
    proc.take()
    proc.manager.events.trigger('x', NIL)
    b.stop()
    proc.manager.events.trigger('x', NIL)
    expect(proc.take()).toEqual([
      '[script:b] b',
      '[script:a] a',
      '[resources] Stopping resource b',
      '[script:a] a',
    ])
  })

  it('name the resource that triggered them as the invoking one', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `AddEventHandler('x', function() print(GetCurrentResourceName(), GetInvokingResource()) end)`,
    )
    expect(start(proc, 'b', `TriggerEvent('x')`)).toEqual(['[script:a] a\tb'])
    proc.manager.events.trigger('x', NIL)
    expect(start(proc, 'c', `AddEventHandler('x', function() end) TriggerEvent('x')`)).toEqual([
      '[script:a] a\tnil',
      '[script:a] a\tc',
    ])
  })
})

describe('onResourceStop held back', () => {
  it('reaches no resource while the process holds it back, and is not canceled, as in FiveM', async () => {
    const proc = await createProcess({ side: 'client' })
    start(
      proc,
      'a',
      `AddEventHandler('onResourceStop', function(name) print('stop', name) end)
AddEventHandler('other', function() print('other') end)`,
    )
    const { events } = proc.manager
    const results: boolean[] = []
    events.holdingResourceStops(() => {
      results.push(events.trigger('onResourceStop', pack(['x'])), events.lastCanceled)
      events.trigger('other', pack([]))
    })
    expect([results, proc.take()]).toEqual([[true, false], ['[script:a] other']])
    events.trigger('onResourceStop', pack(['x']))
    expect(proc.take()).toEqual(['[script:a] stop\tx'])
  })
})

describe('queued events', () => {
  it('trigger at the next tick, before threads resume', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `AddEventHandler('queued', function() print('queued') end)
CreateThread(function() print('thread') end)`,
    )
    proc.manager.events.queue('queued', NIL)
    expect(proc.take()).toEqual([])
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] queued', '[script:a] thread'])
  })
})

describe('threads queued by other resources during a tick', () => {
  it('wait for the next tick, as in FiveM', async () => {
    const proc = await createProcess()
    start(
      proc,
      'a',
      `CreateThread(function()
    print('a triggers')
    TriggerEvent('toB')
end)`,
    )
    start(
      proc,
      'b',
      `AddEventHandler('toB', function()
    print('b handles')
    Wait(0)
    print('b resumes')
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual(['[script:a] a triggers', '[script:b] b handles'])
    proc.tickAt(1)
    expect(proc.take()).toEqual(['[script:b] b resumes'])
  })
})

describe('helpers of each side', () => {
  it('trigger events of clients on servers, with their arguments packed', async () => {
    const { calls, natives } = recorder([
      [
        'TRIGGER_CLIENT_EVENT_INTERNAL',
        ['char* eventName', 'char* eventTarget', 'buffer eventPayload', 'int payloadLength'],
      ],
      [
        'TRIGGER_LATENT_CLIENT_EVENT_INTERNAL',
        [
          'char* eventName',
          'char* eventTarget',
          'buffer eventPayload',
          'int payloadLength',
          'int bps',
        ],
      ],
    ])
    const proc = await createProcess({ natives })
    start(
      proc,
      'a',
      `TriggerClientEvent('x', 5, 1, 'a')
TriggerLatentClientEvent('y', -1, '100', true)`,
    )
    expect(calls).toEqual([
      'TRIGGER_CLIENT_EVENT_INTERNAL x 5 [146,1,161,97] 4',
      'TRIGGER_LATENT_CLIENT_EVENT_INTERNAL y -1 [145,195] 2 100',
    ])
  })

  it('trigger events of servers on clients, with their arguments packed', async () => {
    const { calls, natives } = recorder([
      [
        'TRIGGER_SERVER_EVENT_INTERNAL',
        ['char* eventName', 'buffer eventPayload', 'int payloadLength'],
      ],
      [
        'TRIGGER_LATENT_SERVER_EVENT_INTERNAL',
        ['char* eventName', 'buffer eventPayload', 'int payloadLength', 'int bps'],
      ],
    ])
    const proc = await createProcess({ side: 'client', natives })
    expect(
      start(
        proc,
        'a',
        `TriggerServerEvent('x', 1, 'a')
TriggerLatentServerEvent('y', '50', true)
print(TriggerClientEvent, RconPrint, PerformHttpRequest)`,
      ),
    ).toEqual(['[script:a] nil\tnil\tnil'])
    expect(calls).toEqual([
      'TRIGGER_SERVER_EVENT_INTERNAL x [146,1,161,97] 4',
      'TRIGGER_LATENT_SERVER_EVENT_INTERNAL y [145,195] 2 50',
    ])
  })

  it('include those of the console and of players on servers', async () => {
    const proc = await createProcess()
    expect(
      start(
        proc,
        'a',
        `RconPrint('printed\\n')
print(RconLog('x'), RegisterServerEvent == RegisterNetEvent, rawequal(GetPlayerEP, GetPlayerEndpoint))
print(TriggerServerEvent, type(GetPlayers), type(GetPlayerIdentifiers), type(GetPlayerTokens))`,
      ),
    ).toEqual([
      '[script:a] printed',
      '[script:a] nil\ttrue\ttrue',
      '[script:a] nil\tfunction\tfunction\tfunction',
    ])
  })

  it('give HTTP responses on servers to the callbacks of their requests, once', async () => {
    const ids = [7, -1]
    const requests: Uint8Array[] = []
    const http = defineNative(
      { name: 'PERFORM_HTTP_REQUEST_INTERNAL_EX', result: 'int', params: ['object requestData'] },
      (_ctx: NativeContext, requestData) => {
        requests.push(requestData!)
        return ids.shift()!
      },
    )
    const proc = await createProcess({ natives: [http] })
    expect(
      start(
        proc,
        'a',
        `PerformHttpRequest('http://a', function(status, body, headers, err)
    print('response', status, body, headers.h, err)
end)
PerformHttpRequest('http://b', function(status, body, headers, err)
    print('failed', status, body, next(headers), err)
end, 'POST', 'sent', { k = 'v' }, { followLocation = false })`,
      ),
    ).toEqual(['[script:a] failed\t0\tnil\tnil\tFailure handling HTTP request'])
    const state = proc.manager.getResource('a')!.runtime!.state
    const read = `local t = msgpack.unpack(...)
return t.url, t.method, t.data, t.headers.k or 'none', t.followLocation`
    expect(requests.map((request) => state.run(read, '=read', request))).toEqual([
      ['http://a', 'GET', '', 'none', true],
      ['http://b', 'POST', 'sent', 'v', false],
    ])
    const response = pack([7, 200, 'ok', { h: 'v' }, null])
    proc.manager.events.trigger('__cfx_internal:httpResponse', response)
    proc.manager.events.trigger('__cfx_internal:httpResponse', response)
    expect(proc.take()).toEqual(['[script:a] response\t200\tok\tv\tnil'])
  })

  it('await HTTP responses on servers in PerformHttpRequestAwait', async () => {
    const http = defineNative(
      { name: 'PERFORM_HTTP_REQUEST_INTERNAL_EX', result: 'int', params: ['object requestData'] },
      () => 9,
    )
    const proc = await createProcess({ natives: [http] })
    start(
      proc,
      'a',
      `CreateThread(function()
    local status, body, headers, err = PerformHttpRequestAwait('http://a')
    print('awaited', status, body, type(headers), err)
end)`,
    )
    proc.tickAt(0)
    expect(proc.take()).toEqual([])
    proc.manager.events.trigger('__cfx_internal:httpResponse', pack([9, 404, '', [], 'missing']))
    expect(proc.take()).toEqual(['[script:a] awaited\t404\t\ttable\tmissing'])
  })
})
