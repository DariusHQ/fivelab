import { describe, expect, it } from 'vitest'

import { Commands } from '../../src/core/console/commands.ts'
import { Security } from '../../src/core/console/security.ts'
import { VariableFlags, Variables } from '../../src/core/console/variables.ts'

/** The variables of a console, which the console runs commands for, as "[channel] text" prints. */
function createVariables(server = true) {
  const security = new Security()
  security.addEntry('system.console', 'command', 'allow')
  const printed: string[] = []
  const output = {
    print: (channel: string, text: string) => printed.push(`[${channel}] ${text}`),
    printWarning: (channel: string, text: string) => printed.push(`[${channel}] warning ${text}`),
    printDeveloper: (channel: string, text: string) =>
      printed.push(`[${channel}] developer ${text}`),
  }
  const commands = new Commands(security, output)
  const buffer: string[] = []
  const variables = new Variables({
    commands,
    security,
    output,
    server,
    addToBuffer: (text) => buffer.push(text),
  })
  const run = (line: string) => security.runAs('system.console', () => commands.invoke(line))
  const value = (name: string) => variables.find(name)?.value
  return { security, commands, variables, printed, buffer, run, value }
}

describe('Variables', () => {
  it('have the commands that set them, sets on servers only', () => {
    const names = (server: boolean) => createVariables(server).commands.list.map((c) => c.name)
    expect(names(true)).toEqual([
      '+vstr',
      '-vstr',
      'set',
      'seta',
      'setr',
      'sets',
      'toggle',
      'toggle',
      'vstr',
    ])
    expect(names(false)).toEqual([
      '+vstr',
      '-vstr',
      'set',
      'seta',
      'setr',
      'toggle',
      'toggle',
      'vstr',
    ])
  })

  it('are created by set as strings, which are modified, with commands of their names', () => {
    const { commands, variables, run, value } = createVariables()
    run('set Foo "bar baz"')
    expect(value('foo')).toBe('bar baz')
    expect(variables.find('FOO')?.name).toBe('Foo')
    expect(variables.flagsOf('foo')).toBe(VariableFlags.modified)
    expect(commands.list.filter((c) => c.name === 'Foo')).toEqual([
      { name: 'Foo', resource: 'internal', arity: 0 },
      { name: 'Foo', resource: 'internal', arity: 1 },
    ])
    run('set foo qux')
    expect(value('Foo')).toBe('qux')
    expect(variables.find('Foo')?.name).toBe('Foo')
  })

  it('get the flags of the set commands that set them', () => {
    const { variables, run } = createVariables()
    run('seta a 1')
    run('sets b 1')
    run('setr c 1')
    run('set c 2')
    run('seta c 3')
    const { archive, modified, serverInfo, replicated } = VariableFlags
    expect(variables.flagsOf('a')).toBe(modified | archive)
    expect(variables.flagsOf('b')).toBe(modified | serverInfo)
    expect(variables.flagsOf('c')).toBe(modified | replicated | archive)
    expect(variables.defaultFlagsOf('c')).toBe(modified | replicated)
  })

  it('say what they are when their command runs alone, and are set by it otherwise', () => {
    const { printed, run, value } = createVariables()
    run('setr foo bar')
    run('foo')
    run('foo baz')
    run('foo a b')
    expect(value('foo')).toBe('baz')
    expect(printed).toEqual([
      '[cmd]  "foo" is "bar"\n default: "" - flags( Modified Replicated )\n type: string\n',
      '[cmd] Argument count mismatch (passed 2, wanted 1)\n',
    ])
  })

  it('keep values of their types, within their ranges', () => {
    const { variables, printed, run, value } = createVariables()
    variables.define('sv_maxclients', VariableFlags.serverInfo, 'int', 48).setRange(1, 2048)
    run('sv_maxclients')
    run('sv_maxclients abc')
    run('sv_maxclients 5000')
    run('set sv_maxclients 0')
    expect(value('sv_maxclients')).toBe('48')
    run('set sv_maxclients 64abc')
    expect(value('sv_maxclients')).toBe('64')
    run('sv_maxclients -1')
    expect(printed).toEqual([
      '[cmd]  "sv_maxclients" is "48"\n default: "48" - flags( ServerInfo )\n type: int\n',
      '[cmd] Could not convert argument 0 (abc) to int\n',
      '[cmd] Value out of range (5000) - should be at most 2048\n',
      '[cmd] Value out of range (0) - should be at least 1\n',
      '[cmd] Value out of range (-1) - should be at least 1\n',
    ])
  })

  it('read booleans as true or false in any case, or as numbers that are not 0', () => {
    const { variables, run, value } = createVariables()
    variables.define('flag', VariableFlags.none, 'bool', false)
    const results = ['TRUE', 'False', '2', '0', 'yes', '" 1"', '-1'].map((text) => {
      run(`flag ${text}`)
      return value('flag')
    })
    expect(results).toEqual(['true', 'false', 'true', 'false', 'false', 'true', 'true'])
  })

  it('cannot be set when internal or read-only', () => {
    const { variables, printed, run, value } = createVariables()
    variables.define('locked', VariableFlags.internal, 'string', 'a')
    variables.define('fixed', VariableFlags.readOnly, 'string', 'b')
    run('set locked x')
    run('locked x')
    run('seta fixed x')
    run('fixed x')
    variables.suppressReadOnlyWarning = true
    run('set fixed x')
    run('fixed x')
    expect([value('locked'), value('fixed')]).toEqual(['a', 'b'])
    expect(variables.flagsOf('fixed')).toBe(VariableFlags.readOnly)
    expect(printed).toEqual([
      "[cmd] warning 'locked' is an internal ConVar and cannot be changed.\n",
      "[cmd] warning 'locked' is an internal ConVar and cannot be changed.\n",
      "[cmd] warning 'fixed' is read only. Try using `+set` in the command line.\n",
      "[cmd] warning 'fixed' is read only. Try using `+set` in the command line, or prefixing the command with `set` in the server startup script.\n",
    ])
  })

  it('are not set on clients when replicated, but by code that may set them', () => {
    const { security, variables, printed, run, value } = createVariables(false)
    run('setr fromServer 1')
    expect(value('fromServer')).toBe('')
    expect(variables.flagsOf('fromServer')).toBe(VariableFlags.modified | VariableFlags.replicated)
    security.addEntry('system.internal', 'builtin', 'allow')
    security.runAs('system.internal', () => variables.find('fromServer')!.set('2'))
    expect(value('fromServer')).toBe('2')
    expect(printed).toEqual([
      '[cmd] Cannot set server-replicated ConVar fromServer from client console.\n',
    ])
  })

  it('are toggled between 1 and 0, or two values, booleans being numbers', () => {
    const { variables, run, value } = createVariables()
    run('set a 1')
    run('toggle a')
    expect(value('a')).toBe('0')
    run('toggle a')
    run('toggle A')
    expect(value('a')).toBe('0')
    run('set b x')
    run('toggle b x y')
    expect(value('b')).toBe('y')
    run('toggle b x y')
    expect(value('b')).toBe('x')
    variables.define('c', VariableFlags.none, 'bool', true)
    run('toggle c')
    expect(value('c')).toBe('false')
    run('set d constructor')
    run('toggle d')
    expect(value('d')).toBe('1')
    run('toggle nope')
  })

  it('run the commands they hold with vstr, +vstr and -vstr', () => {
    const { buffer, run } = createVariables()
    run('set a "say a"')
    run('set b "say b"')
    run('vstr a')
    run('+vstr a b')
    run('-vstr a b')
    run('vstr nope')
    expect(buffer).toEqual(['say a\n', 'say a\n', 'say b\n'])
  })

  it('tell listeners of the variables whose values change, as FiveM calls those of events', () => {
    const { variables, run } = createVariables()
    const seen: string[] = []
    const listen = (label: string, also?: (name: string) => void) =>
      variables.watch((name) => {
        seen.push(`${label} ${name}`)
        also?.(name)
      })
    // Listeners may stop listening, and those that the last one adds miss the change.
    const first = listen('first', (name) => {
      if (name !== 'b') return
      listen('third', (later) => {
        if (later === 'c') listen('fourth')
      })
    })
    const second = listen('second', (name) => {
      if (name === 'c') variables.unwatch(second)
    })
    expect([first, second]).toEqual([0, 1])
    run('set A 1')
    run('set a 1')
    run('set b 2')
    run('set c 3')
    run('set d 4')
    variables.unwatch(first)
    run('set e 5')
    expect(seen).toEqual([
      ...['first A', 'second A'],
      ...['first b', 'second b', 'third b'],
      ...['first c', 'second c', 'third c'],
      ...['first d', 'third d', 'fourth d'],
      ...['third e', 'fourth e'],
    ])
  })

  it('forget listeners that stop listening', () => {
    const { variables, run } = createVariables()
    const seen: string[] = []
    variables.watch((name) => {
      seen.push(`first ${name}`)
      if (name === 'a') variables.watch((later) => seen.push(`added ${later}`))
    })
    variables.unwatch(variables.watch((name) => seen.push(`second ${name}`)))
    run('set a 1')
    run('set b 1')
    expect(seen).toEqual(['first a', 'first b', 'added b'])
  })

  it('go on past listeners that a listener stops from listening', () => {
    const { variables, run } = createVariables()
    const seen: string[] = []
    variables.watch((name) => {
      seen.push(`first ${name}`)
      variables.unwatch(second)
    })
    const second = variables.watch((name) => seen.push(`second ${name}`))
    variables.watch((name) => seen.push(`third ${name}`))
    run('set a 1')
    run('set b 1')
    expect(seen).toEqual(['first a', 'third a', 'first b', 'third b'])
  })

  it('give trackers their values now, and each time they are set, even to the same value', () => {
    const { variables, run } = createVariables()
    run('set limit 5')
    const variable = variables.define('limit', VariableFlags.none, 'int', 1)
    variable.setRange(0, 10)
    const seen: unknown[] = []
    variable.track((value) => seen.push(value))
    run('limit 5')
    run('limit 7')
    run('limit 70')
    run('limit x')
    expect(seen).toEqual([5, 5, 7])
  })

  it('are marked modified when their values change', () => {
    const { variables, run } = createVariables()
    variables.define('plain', VariableFlags.none, 'string', 'a')
    run('plain a')
    expect(variables.flagsOf('plain')).toBe(VariableFlags.none)
    run('plain b')
    expect(variables.flagsOf('plain')).toBe(VariableFlags.modified)
  })

  it('stay when defined again with their types, and keep their commands', () => {
    const { commands, variables, run, value } = createVariables()
    run('set same 1')
    const variable = variables.find('same')
    expect(variables.define('same', VariableFlags.archive, 'string', 'x')).toBe(variable)
    expect(variables.flagsOf('same')).toBe(VariableFlags.archive)
    run('same 2')
    expect(value('same')).toBe('2')
    expect(commands.list.filter((c) => c.name === 'same')).toHaveLength(2)
  })

  it('are replaced by variables of other types, which keep their values', () => {
    const { commands, variables, run, value } = createVariables()
    run('set limit 32')
    const same = variables.create('limit', 'string', 'x')
    expect(same).toBe(variables.find('limit'))
    const typed = variables.define('Limit', VariableFlags.none, 'int', 8)
    expect(variables.find('limit')).toBe(typed)
    expect(value('limit')).toBe('32')
    expect(variables.flagsOf('limit')).toBe(VariableFlags.none)
    expect(commands.list.filter((c) => c.name.toLowerCase() === 'limit')).toEqual([
      { name: 'Limit', resource: 'internal', arity: 0 },
      { name: 'Limit', resource: 'internal', arity: 1 },
    ])
  })

  it('are unregistered by token, or by name as written', () => {
    const { commands, variables, run } = createVariables()
    run('set Foo 1')
    const token = variables.register('bar', VariableFlags.none, variables.create('bar', 'int', 1))
    variables.unregisterName('foo')
    expect(variables.find('foo')).toBeDefined()
    variables.unregisterName('Foo')
    variables.unregister(token)
    variables.unregister(token)
    expect([variables.find('foo'), variables.find('bar')]).toEqual([undefined, undefined])
    expect(commands.has('foo') || commands.has('bar')).toBe(false)
    expect(commands.has('set')).toBe(true)
  })

  it('list those with any of the flags of a mask, and all for -1', () => {
    const { variables, run } = createVariables()
    variables.define('plain', VariableFlags.none, 'string', '')
    run('seta kept 1')
    run('setr shared 1')
    const names = (mask?: number) => variables.list(mask).map(({ name }) => name)
    expect(names()).toEqual(['kept', 'plain', 'shared'])
    expect(names(VariableFlags.archive)).toEqual(['kept'])
    expect(names(VariableFlags.archive | VariableFlags.replicated)).toEqual(['kept', 'shared'])
    expect(names(0)).toEqual([])
  })
})
