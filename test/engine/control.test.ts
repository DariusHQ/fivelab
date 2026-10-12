import { describe, expect, it } from 'vitest'

import { createProcess, runCommand, type TestProcess } from './helpers.ts'

/** Runs a command line as the console of the process, and returns what it printed. */
function run(proc: TestProcess, line: string, principal = 'system.console'): string[] {
  runCommand(proc.manager, line, principal)
  return proc.take()
}

/** What FiveM's server traces when a command finds no resource of a name. */
function notFound(name: string): string {
  return `[citizen-server-impl] ^3Couldn't find resource ${name}.^7`
}

describe('Commands that control resources', () => {
  it('start and stop resources, or those that provide their name', async () => {
    const proc = await createProcess()
    proc.add('a', {})
    proc.manager.addResource('b', { files: {}, metadata: [['provide', 'c']] })
    expect(run(proc, 'start a')).toEqual(['[resources] Started resource a'])
    expect(run(proc, 'start c')).toEqual(['[resources] Started resource b'])
    expect(run(proc, 'start a')).toEqual([])
    expect(run(proc, 'stop c')).toEqual(['[resources] Stopping resource b'])
    expect(run(proc, 'stop a')).toEqual(['[resources] Stopping resource a'])
    expect(run(proc, 'stop a')).toEqual([])
    expect(run(proc, 'start x')).toEqual([notFound('x')])
    expect(run(proc, 'stop x')).toEqual([notFound('x')])
    expect(run(proc, 'start ""')).toEqual([])
    expect(run(proc, 'stop ""')).toEqual([])
    expect(run(proc, 'start')).toEqual(['[cmd] Argument count mismatch (passed 0, wanted 1)'])
    expect(run(proc, 'stop a b')).toEqual(['[cmd] Argument count mismatch (passed 2, wanted 1)'])
  })

  it('say which resources stay stopped or started', async () => {
    const proc = await createProcess()
    proc.manager.addResource('a', { files: {}, metadata: [['dependency', 'missing']] })
    expect(run(proc, 'start a')).toEqual([
      '[citizen-resources-core] Could not find dependency missing for resource a.',
      "[citizen-server-impl] ^3Couldn't start resource a.^7",
    ])
    const b = proc.add('b', {})
    b.start()
    b.onStop.connect(() => false)
    proc.take()
    expect(run(proc, 'stop b')).toEqual([
      '[resources] Stopping resource b',
      "[citizen-server-impl] ^3Couldn't stop resource b.^7",
    ])
    expect(b.state).toBe('started')
  })

  it('say nothing of resources that their hooks started or stopped meanwhile', async () => {
    const proc = await createProcess()
    const a = proc.add('a', {})
    let again = true
    const once = (fn: () => void) => () => {
      if (!again) return true
      again = false
      fn()
      return false
    }
    a.onStart.connect(once(() => a.start()))
    a.onStop.connect(once(() => a.stop()))
    expect(run(proc, 'start a')).toEqual(['[resources] Started resource a'])
    expect(a.state).toBe('started')
    again = true
    expect(run(proc, 'stop a')).toEqual([
      '[resources] Stopping resource a',
      '[resources] Stopping resource a',
    ])
    expect(a.state).toBe('stopped')
  })

  it('restart resources that are started', async () => {
    const proc = await createProcess()
    proc.add('a', {})
    expect(run(proc, 'restart a')).toEqual([
      "[citizen-server-impl] Can't restart a stopped resource.",
    ])
    run(proc, 'start a')
    expect(run(proc, 'restart a')).toEqual([
      '[resources] Stopping resource a',
      '[resources] Started resource a',
    ])
    expect(run(proc, 'restart x')).toEqual([notFound('x')])
    expect(run(proc, 'restart ""')).toEqual([notFound('')])
    expect(run(proc, 'restart')).toEqual(['[cmd] Argument count mismatch (passed 0, wanted 1)'])
  })

  it('ensure resources, which they restart once the server is configured', async () => {
    const proc = await createProcess()
    const { manager } = proc
    proc.add('a', {})
    expect(manager.configured).toBe(false)
    expect(run(proc, 'ensure a')).toEqual(['[resources] Started resource a'])
    expect(run(proc, 'ensure a')).toEqual([])
    manager.endInitialConfiguration()
    expect(manager.configured).toBe(true)
    expect(run(proc, 'ensure a')).toEqual([
      '[resources] Stopping resource a',
      '[resources] Started resource a',
    ])
    run(proc, 'stop a')
    expect(run(proc, 'ensure a')).toEqual(['[resources] Started resource a'])
    expect(run(proc, 'ensure x')).toEqual([notFound('x')])
    expect(run(proc, 'ensure ""')).toEqual([notFound('')])
    expect(run(proc, 'ensure')).toEqual(['[cmd] Argument count mismatch (passed 0, wanted 1)'])
  })

  it('neither restart nor stop to ensure resources that are starting', async () => {
    const proc = await createProcess()
    proc.manager.endInitialConfiguration()
    const a = proc.add('a', {})
    const printed: string[][] = []
    a.onBeforeStart.connect(() => {
      if (printed.length === 0) printed.push(run(proc, 'restart a'), run(proc, 'ensure a'))
    })
    a.start()
    expect(printed).toEqual([
      ["[citizen-server-impl] Can't restart a stopped resource."],
      ['[resources] Started resource a'],
    ])
  })

  it('run start and stop as commands, which their callers must be allowed to run', async () => {
    const proc = await createProcess()
    const { manager } = proc
    proc.add('a', {}).start()
    manager.endInitialConfiguration()
    proc.take()
    for (const command of ['restart', 'ensure']) {
      manager.security.addEntry('resource.b', `command.${command}`, 'allow')
      expect(run(proc, `${command} a`, 'resource.b')).toEqual([
        '[cmd] Access denied for command stop.',
        '[cmd] Access denied for command start.',
      ])
    }
  })

  it('take the categories of resources from their paths', async () => {
    const proc = await createProcess()
    const categories = (path: string) =>
      proc.manager.addResource(path, { files: {}, metadata: [], path }).categories
    expect(categories('resources/[a]/[b]/x')).toEqual(['[a]', '[b]'])
    expect(categories('resources\\[a]\\x\\')).toEqual(['[a]'])
    expect(categories('C:/[a]/server/resources/[b]/x')).toEqual(['[b]'])
    expect(categories('resources/[a]/x/[b]/y')).toEqual(['[b]'])
    expect(categories('[a]/[]/x')).toEqual(['[a]', '[]'])
    expect(categories('resources/[a/x')).toEqual([])
    expect(categories('resources/a]/x')).toEqual([])
    expect(categories('resources/[a]')).toEqual([])
    expect(categories('')).toEqual([])
    expect(proc.manager.addResource('x', { files: {}, metadata: [] }).categories).toEqual([])
  })

  it('start, stop and ensure the resources of categories in the order of their bytes', async () => {
    const proc = await createProcess()
    const { manager } = proc
    const fullwidth = String.fromCodePoint(0xff5a)
    const emoji = String.fromCodePoint(0x1f600)
    for (const [name, path] of [
      [emoji, `resources/[maps]/${emoji}`],
      ['b', 'resources/[maps]/b'],
      [fullwidth, `resources/[maps]/${fullwidth}`],
      ['B', 'resources/[maps]/[local]/B'],
      ['c', 'resources/c'],
    ] as const) {
      manager.addResource(name, { files: {}, metadata: [], path })
    }
    const started = (...names: string[]) =>
      names.map((name) => `[resources] Started resource ${name}`)
    expect(run(proc, 'start [maps]')).toEqual(started('B', 'b', fullwidth, emoji))
    expect(run(proc, 'stop [local]')).toEqual(['[resources] Stopping resource B'])
    expect(run(proc, 'ensure [maps]')).toEqual(started('B'))
    expect(run(proc, 'start [none]')).toEqual([
      "[citizen-server-impl] ^3Couldn't find resource category [none].^7",
    ])
    expect(run(proc, 'stop [c]')).toEqual([
      "[citizen-server-impl] ^3Couldn't find resource category [c].^7",
    ])
    expect(run(proc, 'ensure []')).toEqual([
      "[citizen-server-impl] ^3Couldn't find resource category [].^7",
    ])
    expect(run(proc, 'restart [maps]')).toEqual([notFound('[maps]')])
    manager.endInitialConfiguration()
    expect(run(proc, 'ensure [local]')).toEqual([
      '[resources] Stopping resource B',
      '[resources] Started resource B',
    ])
  })

  it('trace up to the first NUL of what they print, as FiveM does', async () => {
    const proc = await createProcess()
    expect(run(proc, 'start "a\0b"')).toEqual([])
    expect(run(proc, 'start x')).toEqual([
      `[citizen-server-impl] ^3Couldn't find resource a^3Couldn't find resource x.^7`,
    ])
  })

  it('belong to servers', async () => {
    const proc = await createProcess({ side: 'client' })
    proc.add('a', {})
    expect(run(proc, 'start a')).toEqual(['[cmd] No such command start.'])
  })
})
