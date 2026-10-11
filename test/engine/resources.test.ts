import { describe, expect, it } from 'vitest'

import { ManifestError, type NativeContext } from '../../src/core/engine/index.ts'
import { defineNative } from '../../src/core/natives/index.ts'
import { createProcess } from './helpers.ts'

describe('resources', () => {
  it('read their manifest when they come without metadata', async () => {
    const proc = await createProcess()
    const res = proc.add('a', {
      'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_scripts { 'first.lua', 'second.lua' }`,
      'first.lua': `print('first')`,
      'second.lua': `print('second')`,
    })
    expect(res.path).toBe('resources/a')
    expect(res.entries('server_script')).toEqual(['first.lua', 'second.lua'])
    expect(res.entries('is_cfxv2')).toEqual(['true'])
    res.start()
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] first',
      '[script:a] second',
      '[resources] Started resource a',
    ])
  })

  it('are not added when their manifest does not load', async () => {
    const proc = await createProcess()
    expect(() => proc.add('a', { 'fxmanifest.lua': `fx_version = = 'cerulean'` })).toThrow(
      new ManifestError(
        "Could not parse resource metadata file resources/a/fxmanifest.lua: a/fxmanifest.lua:1: unexpected symbol near '='",
      ),
    )
    expect(proc.manager.getResource('a')).toBe(undefined)
  })

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

  it('run the scripts their entries glob, those of each entry in the order of their bytes', async () => {
    const proc = await createProcess()
    const script = (name: string) => `print('${name}')`
    proc
      .add(
        'a',
        {
          'main.lua': script('main'),
          'client/b.lua': script('client/b'),
          'client/A.lua': script('client/A'),
          'client/deep/c.lua': script('client/deep/c'),
        },
        [
          ['server_script', 'main.lua'],
          ['server_script', 'client/**/*.lua'],
          ['server_script', 'main.lua'],
        ],
      )
      .start()
    expect(proc.take().filter((line) => line.startsWith('[script:'))).toEqual([
      '[script:a] main',
      '[script:a] client/A',
      '[script:a] client/b',
      '[script:a] client/deep/c',
      '[script:a] main',
    ])
  })

  it('run scripts of other resources, named as @resource/file, under those names', async () => {
    const proc = await createProcess()
    proc.add(
      'lib',
      {
        'init.lua': `print('lib init in', GetCurrentResourceName())`,
        'broken.lua': `local = 1`,
        'error.lua': `error('oops')`,
      },
      [],
    )
    proc
      .add('a', {
        'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
shared_scripts {
    '@lib/init.lua',
    '@lib/./init.lua',
    '@lib/broken.lua',
    '@lib/error.lua',
    '@lib/missing.lua',
    '@missing/init.lua',
}`,
      })
      .start()
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] lib init in\ta',
      '[script:a] lib init in\ta',
      "[script:a] Error parsing script @lib/broken.lua in resource a: @lib/broken.lua:1: <name> expected near '='",
      '[citizen-scripting-core] Failed to load script @lib/broken.lua.',
      '[script:a] ^1SCRIPT ERROR: @lib/error.lua:1: oops^7',
      '[citizen-scripting-core] Failed to load script @lib/missing.lua.',
      '[citizen-scripting-core] Failed to load script @missing/init.lua.',
      '[resources] Started resource a',
    ])
  })

  it('skip scripts they do not have, report those that do not load, and go on with the others', async () => {
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
      "[script:a] Error parsing script @a/broken.lua in resource a: @a/broken.lua:1: <name> expected near '='",
      '[citizen-scripting-core] Failed to load script broken.lua.',
      '[script:a] ok',
      '[resources:a] ^3Warning: could not find server_script `missing.lua` (defined in :0)^7',
      '[resources] Started resource a (1 warning)',
    ])
  })

  it('have no runtime without Lua scripts, and say which scripts FiveLab skips', async () => {
    const proc = await createProcess()
    const res = proc.add('a', { 'server.js': `console.log('js')` })
    res.start()
    expect(res.runtime).toBe(null)
    expect(proc.take()).toEqual(['[resources] Started resource a'])
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
    expect(proc.take()).toEqual(['[resources] Stopping resource a'])
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
      '[resources] Stopping resource a',
      '[script:a] still running\ta',
      '[resources] Started resource a',
    ])
  })

  it('keep their runtime when they are started while they start, which FiveM does not handle', async () => {
    const start = defineNative(
      { name: 'START_THIS_RESOURCE', result: 'void', params: [] },
      (ctx: NativeContext) => {
        ctx.resource.start()
      },
    )
    const proc = await createProcess({ natives: [start] })
    const res = proc.add('a', { 'main.lua': `StartThisResource()\nprint('loaded once')` })
    expect(res.start()).toBe(true)
    expect(res.state).toBe('started')
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[resources] Started resource a',
      '[script:a] loaded once',
      '[resources] Started resource a',
    ])
    expect(proc.diagnostics).toEqual([
      'a: a was started while it started. FiveM would then create another runtime for it and load its scripts again in both runtimes, which FiveLab does not emulate: it keeps the runtime it has.',
    ])
  })
})

describe('servers starting resources', () => {
  it('warn about the files that manifests name and resources do not have', async () => {
    const proc = await createProcess()
    proc
      .add('a', {
        'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'
server_script 'missing.lua'
client_scripts { 'client/*.lua', 'nope/*.lua' }
files { 'html/index.html' }`,
        'main.lua': '',
        'client/x.js': '',
      })
      .start()
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      // client/*.lua matched nothing, but client/ exists, so it goes unreported.
      '[resources:a] ^3Warning: could not find client_script `nope/*.lua` (defined in fxmanifest.lua:5)^7',
      '[resources:a] ^3Warning: could not find server_script `missing.lua` (defined in fxmanifest.lua:4)^7',
      '[resources:a] ^3Warning: could not find file `html/index.html` (defined in fxmanifest.lua:6)^7',
      '[resources] Started resource a (3 warnings)',
    ])
  })

  it('count one warning as one, and name no place for entries no manifest defined', async () => {
    const proc = await createProcess()
    proc.add('a', {}, [['shared_script', 'missing.lua']]).start()
    expect(proc.take()).toEqual([
      '[resources:a] ^3Warning: could not find shared_script `missing.lua` (defined in :0)^7',
      '[resources] Started resource a (1 warning)',
    ])
  })

  it('keep fxmanifest.lua resources of other games, or without fx_version, from starting', async () => {
    const cases: [string, string[]][] = [
      [
        `fx_version 'cerulean'`,
        ['[resources] ^3Warning: Resource a does not support the current game (gta5).^7'],
      ],
      [
        `fx_version 'cerulean'\ngame 'rdr3'`,
        ['[resources] ^3Warning: Resource a does not support the current game (gta5).^7'],
      ],
      [
        `fx_version 'cerulean'\ngames { 'common', 'gta5' }`,
        [
          '[resources] ^3Warning: Resource a specifies both `common` and a specific game. This is considered ill-formed.^7',
        ],
      ],
      [
        `game 'gta5'`,
        ['[resources] ^3Warning: Resource a does not specify an `fx_version` in fxmanifest.lua.^7'],
      ],
      [
        // FiveM's server takes versions it does not know as none.
        `fx_version 'Cerulean'\ngame 'gta5'`,
        ['[resources] ^3Warning: Resource a does not specify an `fx_version` in fxmanifest.lua.^7'],
      ],
      [
        `game 'rdr3'`,
        [
          '[resources] ^3Warning: Resource a does not support the current game (gta5).^7',
          '[resources] ^3Warning: Resource a does not specify an `fx_version` in fxmanifest.lua.^7',
        ],
      ],
    ]
    for (const [manifest, warnings] of cases) {
      const proc = await createProcess()
      const res = proc.add('a', { 'fxmanifest.lua': manifest, 'main.lua': `print('ran')` })
      expect(res.start()).toBe(false)
      expect(res.state).toBe('stopped')
      expect(proc.take()).toEqual(warnings)
    }
  })

  it('start resources for any game with common, those of adamant or later, and those with __resource.lua', async () => {
    for (const files of [
      { 'fxmanifest.lua': `fx_version 'adamant'\ngame 'common'` },
      { 'fxmanifest.lua': `fx_version 'bodacious'\ngames { 'gta5', 'rdr3' }` },
      { '__resource.lua': `` },
    ]) {
      const proc = await createProcess()
      expect(proc.add('a', files).start()).toBe(true)
      expect(proc.take()).toEqual(['[resources] Started resource a'])
    }
  })

  it('do not warn on clients', async () => {
    const proc = await createProcess({ side: 'client' })
    proc.add('a', {}, [['client_script', 'missing.lua']]).start()
    expect(proc.take()).toEqual([])
  })
})

describe('starting and stopping', () => {
  /** A script that prints the events of starts and stops of both sides, with the resource they are about. */
  const watch = `for _, name in ipairs({
    'onResourceStarting', 'onResourceStart', 'onResourceStop',
    'onServerResourceStart', 'onServerResourceStop', 'onClientResourceStart', 'onClientResourceStop',
}) do
    AddEventHandler(name, function(resource) print(name, resource) end)
end`

  it('trigger events, as FiveM does', async () => {
    const proc = await createProcess()
    proc.add('watcher', { 'main.lua': watch }).start()
    proc.tickAt(0)
    const a = proc.add('a', { 'main.lua': `print('loading')\n${watch}` })
    proc.take()
    expect(a.start()).toBe(true)
    // Each event goes to the resources that registered for it newest first.
    expect(proc.take()).toEqual([
      '[script:watcher] onResourceStarting\ta',
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] loading',
      '[script:a] onResourceStart\ta',
      '[script:watcher] onResourceStart\ta',
      '[resources] Started resource a',
    ])
    proc.tickAt(1)
    expect(proc.take()).toEqual([
      '[script:a] onServerResourceStart\ta',
      '[script:watcher] onServerResourceStart\ta',
    ])
    expect(a.stop()).toBe(true)
    expect(proc.take()).toEqual([
      '[script:a] onResourceStop\ta',
      '[script:watcher] onResourceStop\ta',
      '[resources] Stopping resource a',
    ])
    proc.tickAt(2)
    expect(proc.take()).toEqual(['[script:watcher] onServerResourceStop\ta'])
  })

  it('trigger the events of clients on clients, for resources without scripts too', async () => {
    const proc = await createProcess({ side: 'client' })
    proc.add('watcher', { 'main.lua': watch }).start()
    proc.tickAt(0)
    const a = proc.add('a', {})
    proc.take()
    a.start()
    proc.tickAt(1)
    a.stop()
    proc.tickAt(2)
    expect(proc.take()).toEqual([
      '[script:watcher] onResourceStarting\ta',
      '[script:watcher] onResourceStart\ta',
      '[script:watcher] onClientResourceStart\ta',
      '[script:watcher] onResourceStop\ta',
      '[script:watcher] onClientResourceStop\ta',
    ])
  })

  it('keep a resource from starting when onResourceStarting is canceled', async () => {
    const proc = await createProcess()
    proc
      .add('guard', {
        'main.lua': `AddEventHandler('onResourceStarting', function(resource)
    if resource == 'a' then CancelEvent() end
end)
AddEventHandler('onServerResourceStart', function(resource) print('started', resource) end)`,
      })
      .start()
    proc.tickAt(0)
    const a = proc.add('a', { 'main.lua': `print('never loads')` })
    proc.take()
    expect(a.start()).toBe(false)
    expect(a.state).toBe('stopped')
    expect(a.runtime).toBe(null)
    proc.tickAt(1)
    expect(proc.take()).toEqual([])
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
      '[resources] Started resource a',
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

describe('resource natives', () => {
  it('tell the state of resources, which is starting until they started', async () => {
    const proc = await createProcess()
    const a = proc.add('a', { 'main.lua': `print('loading', GetResourceState('a'))` })
    proc
      .add('watcher', {
        'main.lua': `for _, name in ipairs({ 'onResourceStarting', 'onResourceStart', 'onServerResourceStart', 'onResourceStop', 'onServerResourceStop' }) do
    AddEventHandler(name, function(resource) print(name, GetResourceState(resource)) end)
end`,
      })
      .start()
    proc.tickAt(0)
    proc.take()
    a.start()
    proc.tickAt(1)
    a.stop()
    proc.tickAt(2)
    expect(proc.take()).toEqual([
      '[script:watcher] onResourceStarting\tstarting',
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] loading\tstarting',
      '[script:watcher] onResourceStart\tstarting',
      '[resources] Started resource a',
      '[script:watcher] onServerResourceStart\tstarted',
      '[script:watcher] onResourceStop\tstarted',
      '[resources] Stopping resource a',
      '[script:watcher] onServerResourceStop\tstopped',
    ])
  })

  it('fail to tell the state of no resource', async () => {
    const proc = await createProcess()
    proc
      .add('a', {
        'main.lua': `print(GetResourceState('a'), GetResourceState('missing'))
print(pcall(GetResourceState, nil))`,
      })
      .start()
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] starting\tmissing',
      '[citizen-scripting-core] script error in native 000000004039b485: Argument at index 0 was null.',
      '[script:a] false\tnative 000000004039b485: Argument at index 0 was null.',
      '[resources] Started resource a',
    ])
  })

  it('list the resources as of the last GetNumResources, for every runtime', async () => {
    const proc = await createProcess()
    proc
      .add('a', {
        'main.lua': `print(GetResourceByFindIndex(0))
local count = GetNumResources()
for i = -1, count do print(i, GetResourceByFindIndex(i)) end`,
      })
      .start()
    proc.add('b', {})
    proc
      .add('c', {
        'main.lua': `print(GetResourceByFindIndex(1))
print(GetNumResources(), GetResourceByFindIndex(1), GetResourceByFindIndex(2))`,
      })
      .start()
    expect(proc.take().filter((line) => line.startsWith('[script:'))).toEqual([
      '[script:a] nil',
      '[script:a] -1\tnil',
      '[script:a] 0\ta',
      '[script:a] 1\tnil',
      '[script:c] nil',
      '[script:c] 3\tb\tc',
    ])
  })

  it('give the entries of manifests by key, in order', async () => {
    const proc = await createProcess()
    proc.add('x', {})
    proc.add('y', {})
    proc
      .add(
        'a',
        {
          'main.lua': `print(GetNumResourceMetadata('a', 'dependency'), GetResourceMetadata('a', 'dependency', 0), GetResourceMetadata('a', 'dependency', 1))
print(GetResourceMetadata('a', 'dependency', 2), GetResourceMetadata('a', 'dependency', -1))
print(GetNumResourceMetadata('a', 'author'), GetResourceMetadata('a', 'author', 0), GetNumResourceMetadata('a', 'Author'))
print(GetNumResourceMetadata('missing', nil), GetResourceMetadata('missing', nil, 0))
print(pcall(GetNumResourceMetadata, 'a', nil))`,
        },
        [
          ['dependency', 'x'],
          ['server_script', 'main.lua'],
          ['author', 'me'],
          ['dependency', 'y'],
        ],
      )
      .start()
    expect(proc.take()).toEqual([
      '[resources] Started resource x',
      '[resources] Started resource y',
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] 2\tx\ty',
      '[script:a] nil\tnil',
      '[script:a] 1\tme\t0',
      '[script:a] 0\tnil',
      '[citizen-scripting-core] script error in native 000000000776e864: Argument at index 1 was null.',
      '[script:a] false\tnative 000000000776e864: Argument at index 1 was null.',
      '[resources] Started resource a',
    ])
  })

  it('start and stop resources on servers, but not their own or those FiveM manages', async () => {
    const proc = await createProcess()
    proc.add('a', {})
    proc.add('chat', {}).start()
    proc
      .add('admin', {
        'main.lua': `print(StartResource('a'), GetResourceState('a'))
print(StartResource('a'), StartResource('missing'), StopResource('missing'))
print(StopResource('a'), GetResourceState('a'))
print(StopResource('a'))
print(StopResource('admin'), StopResource('chat'), GetResourceState('chat'))`,
      })
      .start()
    expect(proc.take()).toEqual([
      '[resources] Started resource chat',
      '[citizen-scripting-core] Creating script environments for admin',
      '[resources] Started resource a',
      '[script:admin] 1\tstarted',
      '[script:admin] 1\tfalse\tfalse',
      '[resources] Stopping resource a',
      '[script:admin] 1\tstopped',
      '[script:admin] 1',
      '[script:admin] false\tfalse\tstarted',
      '[resources] Started resource admin',
    ])
    expect(proc.diagnostics).toEqual([
      'admin: StopResource cannot stop admin: FiveM keeps resources from stopping themselves.',
      'admin: StopResource cannot stop chat: FiveM keeps scripts from stopping spawnmanager, mapmanager, baseevents, chat, sessionmanager, monitor.',
    ])
  })
})

describe('resources that provide others', () => {
  it('stand in for those that are missing or stopped', async () => {
    const proc = await createProcess()
    const { manager } = proc
    const first = proc.add('first', {}, [['provide', 'mysql-async']])
    const second = proc.add('second', {}, [['provide', 'mysql-async']])
    // For a resource that does not exist, the first that provides it does,
    // even when another started.
    expect(manager.getResource('mysql-async')).toBe(first)
    second.start()
    expect(manager.getResource('mysql-async')).toBe(first)
    expect(manager.getResource('mysql-async', false)).toBe(undefined)
    // For a stopped resource, the first that started does.
    const real = proc.add('oxmysql', {})
    proc.add('shim', {}, [['provide', 'oxmysql']])
    const bridge = proc.add('bridge', {}, [['provide', 'oxmysql']])
    expect(manager.getResource('oxmysql')).toBe(real)
    bridge.start()
    expect(manager.getResource('oxmysql')).toBe(bridge)
    expect(manager.getResource('oxmysql', false)).toBe(real)
    real.start()
    expect(manager.getResource('oxmysql')).toBe(real)
  })

  it('stand in for them in natives', async () => {
    const proc = await createProcess()
    proc.add('oxmysql', {})
    proc.add('shim', {}, [
      ['provide', 'oxmysql'],
      ['provide', 'mysql-async'],
      ['author', 'me'],
    ])
    proc
      .add('app', {
        'main.lua': `print(GetResourceState('oxmysql'), GetResourceState('mysql-async'))
print(StartResource('mysql-async'), GetResourceState('shim'), GetResourceState('oxmysql'))
print(GetResourceMetadata('oxmysql', 'author', 0), GetNumResourceMetadata('oxmysql', 'provide'))
print(StopResource('oxmysql'), GetResourceState('shim'))`,
      })
      .start()
    expect(proc.take().filter((line) => line.startsWith('[script:'))).toEqual([
      '[script:app] stopped\tstopped',
      '[script:app] 1\tstarted\tstarted',
      '[script:app] me\t2',
      '[script:app] 1\tstopped',
    ])
  })

  it('do not get the events of those they provide', async () => {
    const proc = await createProcess()
    const handler = `AddEventHandler('ping', function() print('ping') end)`
    const a = proc.add('a', { 'main.lua': handler })
    a.start()
    a.stop()
    proc.add('provider', { 'main.lua': handler }, [
      ['provide', 'a'],
      ['server_script', 'main.lua'],
    ])
    proc.manager.getResource('provider')!.start()
    proc.add('sender', { 'main.lua': `TriggerEvent('ping')` }).start()
    expect(proc.take().filter((line) => line.startsWith('[script:'))).toEqual([
      '[script:provider] ping',
    ])
  })
})
