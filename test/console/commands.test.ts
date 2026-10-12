import { describe, expect, it } from 'vitest'

import { Commands, type CommandCall } from '../../src/core/console/commands.ts'
import { Security } from '../../src/core/console/security.ts'

interface TestCommands {
  readonly security: Security
  readonly commands: Commands
  /** What the commands printed, as "[channel] text". */
  readonly printed: string[]
  /** Runs a command line as the console. */
  run(line: string | Uint8Array, source?: string): void
}

/** Commands that the console may run, which share the security of their fallback, as in FiveM. */
function createCommands(fallbackOf?: TestCommands): TestCommands {
  const fallback = fallbackOf?.commands
  const security = fallbackOf?.security ?? new Security()
  if (fallbackOf === undefined) security.addEntry('system.console', 'command', 'allow')
  const printed: string[] = []
  const output = {
    print: (channel: string, text: string) => printed.push(`[${channel}] ${text}`),
    printWarning: (channel: string, text: string) => printed.push(`[${channel}] warning ${text}`),
    printDeveloper: (channel: string, text: string) =>
      printed.push(`[${channel}] developer ${text}`),
  }
  const commands = new Commands(security, output, fallback)
  const run = (line: string | Uint8Array, source?: string) =>
    security.runAs('system.console', () => commands.invoke(line, source))
  return { security, commands, printed, run }
}

describe('Commands', () => {
  it('list handlers by name as _stricmp orders them, then as registered', () => {
    const { commands } = createCommands()
    const handler = () => true
    commands.register('b', 'r1', handler)
    commands.register('A', 'r2', handler, 2)
    commands.register('a', 'r3', handler, 0)
    commands.register('_x', 'r4', handler)
    expect(commands.list).toEqual([
      { name: '_x', resource: 'r4', arity: -1 },
      { name: 'A', resource: 'r2', arity: 2 },
      { name: 'a', resource: 'r3', arity: 0 },
      { name: 'b', resource: 'r1', arity: -1 },
    ])
  })

  it('match names ignoring the case of ASCII letters and what follows a NUL', () => {
    const { commands } = createCommands()
    const token = commands.register('Say\0x', 'r', () => true)
    commands.register('É', 'r', () => true)
    expect(commands.has('sAY')).toBe(true)
    expect(commands.has('say\0y')).toBe(true)
    expect(commands.has('say2')).toBe(false)
    expect(commands.has('é')).toBe(false)
    commands.unregister(token)
    commands.unregister(token)
    expect(commands.has('say')).toBe(false)
    expect(commands.has('É')).toBe(true)
  })

  it('run commands with their arguments and their line', () => {
    const { commands, run } = createCommands()
    const calls: [readonly string[], string, string][] = []
    commands.register('Say', 'r', (call) => {
      calls.push([call.args, call.source, commands.rawCommand])
      return true
    })
    run('say hello "big world"')
    run(new TextEncoder().encode('SAY é'), '3')
    expect(calls).toEqual([
      [['hello', 'big world'], '', 'say hello "big world"'],
      [['é'], '3', 'SAY é'],
    ])
    expect(commands.rawCommand).toBe('')
  })

  it('run nothing for lines that name no command or do not decode', () => {
    const { printed, run } = createCommands()
    run('')
    run('  # comment')
    run(new Uint8Array([0x73, 0x61, 0x79, 0xff]))
    expect(printed).toEqual([])
  })

  it('try handlers until one takes the arguments, or print why the last did not', () => {
    const { commands, printed, run } = createCommands()
    const ran: string[] = []
    const refuse = (why: string) => (call: CommandCall) => {
      call.error += why
      return false
    }
    commands.register('x', 'r', refuse('first\n'))
    commands.register('x', 'r', (call) => {
      ran.push(`second ${call.error === '' ? 'clean' : call.error}`)
      return call.args.length === 1
    })
    commands.register('x', 'r', refuse('third\n'))
    run('x a')
    run('x a b')
    expect(ran).toEqual(['second clean', 'second clean'])
    expect(printed).toEqual(['[cmd] third\n'])
  })

  it('say when there is no such command, except to clients', () => {
    const { printed, run } = createCommands()
    run('nope a')
    run('nope', '1')
    // Quoted, a name can have a NUL.
    run('"no\0pe"')
    expect(printed).toEqual(['[cmd] No such command nope.\n', '[cmd] No such command no.\n'])
  })

  it('run commands only for those who may access them', () => {
    const { security, commands, printed, run } = createCommands()
    let ran = 0
    commands.register('Quit', 'r', () => ++ran > 0)
    security.runAs('resource.a', () => commands.invoke('QUIT now'))
    security.addEntry('resource.b', 'command.quit', 'allow')
    security.runAs('resource.b', () => commands.invoke('QUIT now'))
    run('quit')
    expect(ran).toBe(2)
    expect(printed).toEqual(['[cmd] Access denied for command QUIT.\n'])
  })

  it('run in their fallback the commands that they do not have, with their line', () => {
    const fallback = createCommands()
    const { commands, printed, run } = createCommands(fallback)
    const lines: string[] = []
    fallback.commands.register('global', 'r', () => lines.push(fallback.commands.rawCommand) > 0)
    commands.register('local', 'r', () => lines.push(commands.rawCommand) > 0)
    run('global 1')
    run('local 2')
    run('neither 3')
    expect(lines).toEqual(['global 1', 'local 2'])
    expect(printed).toEqual([])
    expect(fallback.printed).toEqual(['[cmd] No such command neither.\n'])
  })

  it('forget the line of the command that runs once another ran', () => {
    const { commands, run } = createCommands()
    const lines: string[] = []
    commands.register('inner', 'r', () => true)
    commands.register('outer', 'r', () => {
      lines.push(commands.rawCommand)
      commands.invoke('inner')
      lines.push(commands.rawCommand)
      return true
    })
    run('outer')
    expect(lines).toEqual(['outer', ''])
  })
})

describe('Commands.add', () => {
  it('registers internal commands that take as many arguments as they have parameters', () => {
    const { commands, printed, run } = createCommands()
    const sets: [string, string][] = []
    commands.add('set', ['string', 'string'], (name, value) => sets.push([name, value]))
    run('set a b')
    run('set a')
    run('set a b c')
    expect(sets).toEqual([['a', 'b']])
    expect(printed).toEqual([
      '[cmd] Argument count mismatch (passed 1, wanted 2)\n',
      '[cmd] Argument count mismatch (passed 3, wanted 2)\n',
    ])
    expect(commands.list).toEqual([{ name: 'set', resource: 'internal', arity: 2 }])
  })

  it('reads ints as std::stoull does, cut to 32 bits', () => {
    const { commands, printed, run } = createCommands()
    const waits: number[] = []
    commands.add('wait', ['int'], (ms) => waits.push(ms))
    for (const arg of ['10', '-1', '12abc', '" 7"', '4294967297', '18446744073709551615']) {
      run(`wait ${arg}`)
    }
    run('wait abc')
    run('wait 18446744073709551616')
    expect(waits).toEqual([10, -1, 12, 7, 1, -1])
    expect(printed).toEqual([
      '[cmd] Could not convert argument 0 (abc) to int\n',
      '[cmd] Could not convert argument 0 (18446744073709551616) to int\n',
    ])
  })

  it('gives a last rest parameter the rest of the arguments, which it does not count', () => {
    const { commands, run } = createCommands()
    const calls: [string, string[]][] = []
    commands.add('exec', ['string', 'rest'], (first, rest) => calls.push([first, rest]))
    run('exec a')
    run('exec a b c')
    expect(calls).toEqual([
      ['a', []],
      ['a', ['b', 'c']],
    ])
  })

  it('prints the error of the last overload that does not take the arguments', () => {
    const { commands, printed, run } = createCommands()
    commands.add('toggle', ['string'], () => {})
    commands.add('toggle', ['string', 'string', 'string'], () => {})
    run('toggle a b')
    expect(printed).toEqual(['[cmd] Argument count mismatch (passed 2, wanted 3)\n'])
  })
})
