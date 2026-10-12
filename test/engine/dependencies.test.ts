import { describe, expect, it } from 'vitest'

import { createProcess } from './helpers.ts'

/** An fxmanifest.lua that FiveM's server starts, with `lines` after its version and game. */
function manifest(...lines: string[]): string {
  return [`fx_version 'cerulean'`, `game 'gta5'`, ...lines].join('\n')
}

describe('dependencies', () => {
  it('start first, those of dependency entries before those of dependencies', async () => {
    const proc = await createProcess()
    for (const name of ['a', 'b', 'started']) {
      proc.add(name, {
        'fxmanifest.lua': manifest(`server_script 'main.lua'`),
        'main.lua': `print('${name}')`,
      })
    }
    proc.manager.getResource('started')!.start()
    proc.take()
    const c = proc.add('c', {
      'fxmanifest.lua': manifest(
        `server_script 'main.lua'`,
        `dependencies { 'a', 'started' }`,
        `dependency 'b'`,
      ),
      'main.lua': `print('c')`,
    })
    expect(c.start()).toBe(true)
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for b',
      '[script:b] b',
      '[resources] Started resource b',
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] a',
      '[resources] Started resource a',
      '[citizen-scripting-core] Creating script environments for c',
      '[script:c] c',
      '[resources] Started resource c',
    ])
  })

  it('keep resources from starting when one is missing or does not start, and stop at it', async () => {
    const proc = await createProcess()
    const a = proc.add('a', {}, [['dependency', 'missing']])
    const b = proc.add('b', {})
    const c = proc.add('c', {}, [
      ['dependency', 'a'],
      ['dependency', 'b'],
    ])
    expect(c.start()).toBe(false)
    expect([a.state, b.state, c.state]).toEqual(['stopped', 'stopped', 'stopped'])
    expect(proc.take()).toEqual([
      '[citizen-resources-core] Could not find dependency missing for resource a.',
      '[citizen-resources-core] Could not start dependency a for resource c.',
    ])
  })

  it('trace what they print up to its first NUL, as FiveM does', async () => {
    const proc = await createProcess()
    expect(proc.add('a', {}, [['dependency', 'missing\0b']]).start()).toBe(false)
    proc.manager.log('citizen-resources-core', '\n')
    expect(proc.take()).toEqual(['[citizen-resources-core] Could not find dependency missing'])
  })

  it('start resources once a dependency that did not start starts, before it reports its start', async () => {
    const proc = await createProcess()
    let allowed = false
    const a = proc.add('a', {})
    a.onBeforeStart.connect(() => allowed)
    const b = proc.add('b', { 'main.lua': `print('b')` }, [
      ['dependency', 'a'],
      ['server_script', 'main.lua'],
    ])
    expect(b.start()).toBe(false)
    expect(proc.take()).toEqual([
      '[citizen-resources-core] Could not start dependency a for resource b.',
    ])
    allowed = true
    expect(a.start()).toBe(true)
    expect(b.state).toBe('started')
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for b',
      '[script:b] b',
      '[resources] Started resource b',
      '[resources] Started resource a',
    ])
    // Resources wait for one start only.
    a.stop()
    a.start()
    expect(b.state).toBe('stopped')
    expect(proc.take()).toEqual([
      '[resources] Stopping resource b',
      '[resources] Stopping resource a',
      '[resources] Started resource a',
    ])
  })

  it('stop the resources that depend on them first, in the order of their names', async () => {
    const proc = await createProcess()
    const a = proc.add('a', {})
    for (const name of ['c', 'b', 'B']) proc.add(name, {}, [['dependency', 'a']]).start()
    proc.take()
    expect(a.stop()).toBe(true)
    expect(proc.take()).toEqual([
      '[resources] Stopping resource B',
      '[resources] Stopping resource b',
      '[resources] Stopping resource c',
      '[resources] Stopping resource a',
    ])
    // Restarting a resource leaves those that depended on it stopped.
    a.start()
    expect(proc.take()).toEqual(['[resources] Started resource a'])
  })

  it('may name the resource itself', async () => {
    const proc = await createProcess()
    const a = proc.add('a', {}, [['dependency', 'a']])
    expect(a.start()).toBe(true)
    expect(a.stop()).toBe(true)
    expect(proc.take()).toEqual([
      '[resources] Started resource a',
      '[resources] Stopping resource a',
    ])
  })

  it('stop resources that depend on each other once, which FiveM does not handle', async () => {
    const proc = await createProcess()
    proc
      .add('watcher', {
        'main.lua': `AddEventHandler('onResourceStop', function(resource) print('stop', resource) end)`,
      })
      .start()
    const a = proc.add('a', {}, [['dependency', 'b']])
    const b = proc.add('b', {}, [['dependency', 'a']])
    proc.take()
    expect(a.start()).toBe(true)
    expect(b.state).toBe('started')
    expect(a.stop()).toBe(true)
    expect(b.state).toBe('stopped')
    expect(proc.take()).toEqual([
      '[resources] Started resource b',
      '[resources] Started resource a',
      '[script:watcher] stop\tb',
      '[resources] Stopping resource b',
      '[script:watcher] stop\ta',
      '[resources] Stopping resource a',
    ])
    expect(proc.diagnostics).toEqual([
      'a: a depends on b, which is stopping while a stops the resources that depend on it, as happens when resources depend on each other. FiveM would stop a again, and so on until its stack overflows, which FiveLab does not emulate: it stops a once.',
    ])
  })

  it('start the resources that provide them, and stop with those', async () => {
    const proc = await createProcess()
    const shim = proc.add('shim', { 'main.lua': `print('shim')` }, [
      ['provide', 'mysql-async'],
      ['server_script', 'main.lua'],
    ])
    const app = proc.add(
      'app',
      { 'main.lua': `print(GetResourceState('mysql-async'), GetResourceState('shim'))` },
      [
        ['dependency', 'mysql-async'],
        ['server_script', 'main.lua'],
      ],
    )
    expect(app.start()).toBe(true)
    expect(shim.stop()).toBe(true)
    expect(app.state).toBe('stopped')
    expect(proc.take()).toEqual([
      '[citizen-scripting-core] Creating script environments for shim',
      '[script:shim] shim',
      '[resources] Started resource shim',
      '[citizen-scripting-core] Creating script environments for app',
      '[script:app] started\tstarted',
      '[resources] Started resource app',
      '[resources] Stopping resource app',
      '[resources] Stopping resource shim',
    ])
  })

  it('that are constraints keep resources from starting on servers when they fail, after the others start', async () => {
    const proc = await createProcess({ oneSync: false })
    const a = proc.add('a', {})
    const b = proc.add('b', {
      'fxmanifest.lua': manifest(`dependencies {
    '/server:99999',
    '/onesync',
    'a',
    '/server:5181',
    '/unknown',
    '/server:1:2',
    '/gameBuild:mp2025_01',
    '/gameBuild',
    '/native:0x1',
    '/native:abc',
    '/Server',
    '/on/off',
}`),
    })
    expect(b.start()).toBe(false)
    expect(b.state).toBe('stopped')
    expect(a.state).toBe('started')
    expect(proc.take()).toEqual([
      '[resources] Started resource a',
      "[citizen-resources-core] Resource 'b' can't run:",
      '[citizen-resources-core]   1. server needs to be 99999 or higher',
      '[citizen-resources-core]   2. onesync: ^1OneSync needs to be enabled^7',
      "[citizen-resources-core]   3. constraint 'unknown' is unknown",
      '[citizen-resources-core]   4. constraint syntax error',
      '[citizen-resources-core]   5. gameBuild(mp2025_01): ^1sv_enforceGameBuild needs to be at least 3570 (current is 3258)^7',
      '[citizen-resources-core]   6. gameBuild: ^1no details specified^7',
      "[citizen-resources-core]   7. native(0x1): ^1native 0x1 isn't supported^7",
      '[citizen-resources-core]   8. native(abc): ^1no details specified^7',
      "[citizen-resources-core]   9. constraint 'Server' is unknown",
      "[citizen-resources-core]  10. constraint 'on/off' is unknown",
    ])
  })

  it('that are constraints let resources start when they hold, and on clients whatever they say', async () => {
    const constraints = ['/server:5181', '/onesync', '/gameBuild:h4', '/native:0xE5E9EBBB']
    const server = await createProcess()
    const a = server.add(
      'a',
      {},
      constraints.map((dependency) => ['dependency', dependency] as const),
    )
    expect(a.start()).toBe(true)
    expect(server.take()).toEqual(['[resources] Started resource a'])
    const client = await createProcess({ side: 'client' })
    const b = client.add(
      'b',
      {},
      [...constraints, '/server:99999', '/unknown', '/server:1:2'].map(
        (dependency) => ['dependency', dependency] as const,
      ),
    )
    expect(b.start()).toBe(true)
    expect(client.take()).toEqual([])
  })
})
