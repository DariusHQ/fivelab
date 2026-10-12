import { describe, expect, it } from 'vitest'

import { ConsoleContext } from '../../src/core/console/context.ts'
import { Security } from '../../src/core/console/security.ts'
import { VariableFlags } from '../../src/core/console/variables.ts'

interface TestContext {
  readonly context: ConsoleContext
  /** What the context printed, as "[channel] text". */
  readonly printed: string[]
  /** The lines of the say commands that ran. */
  readonly said: string[]
  /** The time of the context's clock. */
  readonly clock: { now: number }
  /** Runs a command line as the console. */
  run(line: string): void
  /** Runs the buffer as the console. */
  flush(): void
}

/** A server's console, which shares the security and output of its fallback, as in FiveM. */
function createContext(fallbackOf?: TestContext): TestContext {
  const security = fallbackOf?.context.security ?? new Security()
  if (fallbackOf === undefined) security.addEntry('system.console', 'command', 'allow')
  const printed = fallbackOf?.printed ?? []
  const output = {
    print: (channel: string, text: string) => printed.push(`[${channel}] ${text}`),
    printWarning: (channel: string, text: string) => printed.push(`[${channel}] warning ${text}`),
    printDeveloper: (channel: string, text: string) =>
      printed.push(`[${channel}] developer ${text}`),
  }
  const clock = { now: 1000 }
  const context = new ConsoleContext({
    security,
    output,
    server: true,
    clock: () => clock.now,
    ...(fallbackOf === undefined ? {} : { fallback: fallbackOf.context }),
  })
  const said: string[] = []
  context.commands.register('say', 'test', () => said.push(context.commands.rawCommand) > 0)
  const run = (line: string) => security.runAs('system.console', () => context.execute(line))
  const flush = () => security.runAs('system.console', () => context.executeBuffer())
  return { context, printed, said, clock, run, flush }
}

describe('ConsoleContext', () => {
  it('splits its buffer at line breaks, and at semicolons outside quotes and JSON', () => {
    const { context, printed, said, flush } = createContext()
    context.addToBuffer(
      'say a;say "b;c";say d\r\nsay [\n{"d":1},\r2];say {;x}\nsay {"q":"\\""};say e\n',
    )
    context.addToBuffer('say "f;g\nsay "["\\""]";say h\n  say i')
    flush()
    expect(said).toEqual([
      'say a',
      'say "b;c"',
      'say d',
      'say [\n{"d":1},\r2]',
      'say {',
      'say {"q":"\\""}',
      'say e',
      'say "f;g',
      'say "["\\""]";say h',
      '  say i',
    ])
    expect(printed).toEqual(['[cmd] No such command x}.\n'])
    expect(context.bufferEmpty).toBe(true)
  })

  it('joins the bytes added to its buffer before it decodes commands', () => {
    const { context, said, flush } = createContext()
    context.addToBuffer(new Uint8Array([0x73, 0x61, 0x79, 0x20, 0xc3]))
    context.addToBuffer(new Uint8Array([0xa9, 0x0a]))
    context.addToBuffer('say ok')
    flush()
    expect(said).toEqual([`say ${String.fromCharCode(0xe9)}`, 'say ok'])
  })

  it('runs the commands of its buffer up to a wait, and the rest once the wait has ended', () => {
    const { context, said, clock, flush } = createContext()
    context.addToBuffer('say a\n\t\v\f wait 100;say b\nsay c\n')
    flush()
    expect(said).toEqual(['say a'])
    expect(context.bufferEmpty).toBe(false)
    clock.now = 1100
    flush()
    expect(said).toEqual(['say a'])
    clock.now = 1101
    flush()
    expect(said).toEqual(['say a', 'say b', 'say c'])
    expect(context.bufferEmpty).toBe(true)
  })

  it('waits longer for each wait, from the time in whole milliseconds when none waits', () => {
    const { context, said, clock, run, flush } = createContext()
    clock.now = 1000.9
    run('wait 100')
    run('wait 50')
    context.addToBuffer('say a\n')
    clock.now = 1149.5
    flush()
    expect(said).toEqual([])
    clock.now = 1150.5
    flush()
    expect(said).toEqual(['say a'])
    clock.now = 2000
    run('wait 100')
    context.addToBuffer('say b\n')
    flush()
    expect(said).toEqual(['say a'])
    run('wait -200')
    flush()
    expect(said).toEqual(['say a', 'say b'])
  })

  it('stops running its buffer at any command that starts with wait', () => {
    const { context, printed, said, flush } = createContext()
    context.addToBuffer('waitress\nsay a\n\0wait 5\nsay b\n')
    flush()
    expect(said).toEqual([])
    flush()
    expect(said).toEqual(['say a', 'say b'])
    expect(printed).toEqual(['[cmd] No such command waitress.\n'])
  })

  it('is not empty while the commands of its buffer run, nor after one fails', () => {
    const { context, flush } = createContext()
    const seen: boolean[] = []
    context.commands.register('check', 'test', () => seen.push(context.bufferEmpty) > 0)
    context.commands.register('fail', 'test', () => {
      throw new Error('failed')
    })
    expect(context.bufferEmpty).toBe(true)
    context.addToBuffer('check')
    expect(context.bufferEmpty).toBe(false)
    flush()
    expect(seen).toEqual([false])
    context.addToBuffer('fail\ncheck')
    expect(flush).toThrow('failed')
    expect(context.bufferEmpty).toBe(true)
    expect(seen).toEqual([false])
  })

  it('runs commands named with their arguments, without splitting a line', () => {
    const { context } = createContext()
    const calls: string[][] = []
    context.commands.register('echo', 'test', ({ args }) => calls.push([...args]) > 0)
    context.security.runAs('system.console', () => {
      context.executeDirect(['echo', 'a b', '"c";d'])
      context.executeDirect([])
    })
    expect(calls).toEqual([['a b', '"c";d']])
  })

  it('runs the commands it does not have in its fallback, and keeps its own variables', () => {
    const fallback = createContext()
    const { context, said, run } = createContext(fallback)
    run('say a')
    expect(said).toEqual(['say a'])
    fallback.context.commands.register('shout', 'test', () => fallback.said.push('shout') > 0)
    run('shout')
    expect(fallback.said).toEqual(['shout'])
    run('set name server')
    expect(context.variables.find('name')?.value).toBe('server')
    expect(fallback.context.variables.find('name')).toBeUndefined()
  })

  it('runs the commands that its variables hold in its buffer', () => {
    const { said, run, flush } = createContext()
    run('set greet "say hi"')
    run('vstr greet')
    expect(said).toEqual([])
    flush()
    expect(said).toEqual(['say hi'])
  })

  it('lists the commands of its own and of its fallback that the code may run, with values', () => {
    const fallback = createContext()
    const { context, printed, run } = createContext(fallback)
    const handler = () => true
    const smile = String.fromCodePoint(0x1f600)
    const bang = String.fromCharCode(0xff01)
    fallback.context.commands.register('Hello', 'test', handler)
    fallback.context.commands.register(smile, 'test', handler)
    fallback.context.variables.define('shared', VariableFlags.none, 'string', 'theirs')
    fallback.context.variables.define('sv_hostname', VariableFlags.none, 'string', 'Lab')
    context.commands.register('hello', 'test', handler)
    context.commands.register(bang, 'test', handler)
    context.commands.register('secret', 'test', handler)
    context.variables.define('shared', VariableFlags.none, 'string', 'ours')
    context.security.addEntry('system.console', 'command.secret', 'deny')
    run('cmdlist')
    expect(printed).toEqual(
      [
        '+vstr',
        '-vstr',
        'cmdlist',
        'hello',
        'say',
        'set',
        'seta',
        'setr',
        'sets',
        'shared = ours^7',
        'sv_hostname = Lab^7',
        'toggle',
        'vstr',
        'wait',
        bang,
        smile,
      ].map((line) => `[CmdSystem] ${line}\n`),
    )
  })
})
