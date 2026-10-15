import { describe, expect, it, vi } from 'vitest'

import { KEPT_PRINTS, MAX_LISTENER_DEPTH } from '../../src/core/engine/buffer.ts'
import { createProcess, runCommand, startResource, type TestProcess } from './helpers.ts'

/** Lets resources record what their listeners hear with a command, and returns what they record. */
function recordHeard(proc: TestProcess): string[] {
  const heard: string[] = []
  proc.manager.console.commands.register('record', 'test', ({ args }) => {
    heard.push(args.join(' '))
    return true
  })
  runCommand(proc.manager, 'add_ace builtin.everyone command.record allow', 'system.console')
  return heard
}

/** A listener that records what it hears as `label`, with line breaks as slashes. */
function listener(label: string, more = ''): string {
  return `RegisterConsoleListener(function(channel, text)
  ExecuteCommand(('record ${label} %s "%s"'):format(channel, (text:gsub('\\n', '/'))))
  ${more}
end)`
}

describe('The console buffer of servers', () => {
  it('keeps the last prints that filters do not drop', async () => {
    const proc = await createProcess()
    const { manager } = proc
    const buffer = manager.consoleBuffer!
    runCommand(manager, 'con_addChannelFilter gone drop', 'system.console')
    manager.log('forward:a/b', 'kept\n')
    manager.log('gone', 'dropped\n')
    manager.log('cmd', 'part')
    manager.log('cmd', 'ed\0\n')
    expect(buffer.text).toBe('kept\npart' + 'ed^5<\\0>^7\n')
    for (let i = 0; i < KEPT_PRINTS; i++) manager.log('cmd', `${i}\n`)
    expect(buffer.text).toBe([...Array(KEPT_PRINTS).keys()].map((i) => `${i}\n`).join(''))
  })

  it('gives scripts what it keeps', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print('hello')
local text = GetConsoleBuffer()
print(text == '${'Creating script environments for a\\n'}hello\\n')`,
      }),
    ).toEqual(['[script:a] hello', '[script:a] true'])
  })

  it('tells listeners of prints by the names of their resources, then in the order they were added', async () => {
    const proc = await createProcess()
    const { manager } = proc
    const heard = recordHeard(proc)
    startResource(proc, 'b', { 'main.lua': listener('b') })
    const a = proc.add('a', {
      'main.lua': `${listener('a1', `if text == 'two\\n' then ${listener('a3')} end`)}
${listener('a2')}`,
    })
    a.start()
    runCommand(manager, 'con_addChannelFilter hidden noprint', 'system.console')
    heard.length = 0
    manager.log('hidden', 'one\n')
    manager.log('cmd', 'two\n')
    a.stop()
    const called = vi.spyOn(manager, 'invokeFunctionReference')
    manager.log('cmd', 'three\n')
    expect(called.mock.calls.map(([ref]) => ref.split(':')[0])).toEqual(['b'])
    expect(heard).toEqual([
      ...['a1', 'a2', 'b'].map((label) => `${label} hidden one/`),
      ...['a1', 'a2', 'a3', 'b'].map((label) => `${label} cmd two/`),
      ...['a1', 'a2', 'a3', 'b'].map((label) => `${label} resources Stopping resource a/`),
      'b cmd three/',
    ])
  })

  it('tells listeners no deeper than a limit while they print what they hear', async () => {
    const proc = await createProcess()
    // The listener hears of the start of its resource, and of what it prints.
    startResource(proc, 'a', {
      'main.lua': `RegisterConsoleListener(function() print('heard') print('twice') end)`,
    })
    const diagnostic = expect.stringMatching(
      /^a: A console listener printed while it heard of prints, 16 deep: /,
    )
    expect(proc.diagnostics).toEqual([diagnostic])
    proc.manager.log('cmd', 'x\n')
    // Lua's print prints its text, then its line break.
    const printed = proc.take().join('\n')
    expect(printed.match(/heard/g)).toHaveLength(MAX_LISTENER_DEPTH)
    expect(printed.match(/twice/g)).toHaveLength(MAX_LISTENER_DEPTH)
    expect(proc.diagnostics).toEqual([diagnostic, diagnostic])
  })

  it('adds no listener for nil', async () => {
    const proc = await createProcess()
    startResource(proc, 'a', { 'main.lua': `RegisterConsoleListener(nil)` })
    expect(proc.diagnostics).toEqual([
      'a: RegisterConsoleListener was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveRunner adds no listener.',
    ])
  })

  it('is not on clients', async () => {
    const proc = await createProcess({ side: 'client' })
    expect(proc.manager.consoleBuffer).toBeUndefined()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(GetConsoleBuffer, RegisterConsoleListener)`,
      }),
    ).toEqual(['[script:a] nil\tnil'])
  })
})
