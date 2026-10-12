import { describe, expect, it } from 'vitest'

import type { ResourceDefinition, ResourceManager } from '../../src/core/engine/index.ts'
import { createProcess, type TestProcess } from './helpers.ts'

/** Starts a resource with `files` and returns the lines written but those of every start. */
function start(proc: TestProcess, name: string, files: ResourceDefinition['files']): string[] {
  proc.add(name, files).start()
  const starting = [
    `[citizen-scripting-core] Creating script environments for ${name}`,
    `[resources] Started resource ${name}`,
  ]
  return proc.take().filter((line) => !starting.includes(line))
}

/** Runs a command line in the process's console as `principal`, or as no principal. */
function run(manager: ResourceManager, line: string, principal?: string, source = ''): void {
  const execute = () => manager.console.commands.invoke(line, source)
  if (principal === undefined) execute()
  else manager.security.runAs(principal, execute)
}

/** The entries of the process's security for an object. */
function entriesOf(manager: ResourceManager, object: string): string[] {
  return manager.security.entries
    .filter((entry) => entry.object === object)
    .map(({ principal, access }) => `${principal} ${access}`)
}

describe('Commands of scripts', () => {
  it('run the functions of scripts with the source, the arguments and the line', async () => {
    const proc = await createProcess()
    start(proc, 'a', {
      'main.lua': `RegisterCommand('greet', function(source, args, raw)
  print(source, #args, args[1], args[2], raw)
end, false)`,
    })
    run(proc.manager, 'greet "a b" c', 'system.console')
    run(proc.manager, 'GREET x', undefined, '7')
    run(proc.manager, 'greet', undefined, 'abc')
    expect(proc.take()).toEqual([
      '[script:a] 0\t2\ta b\tc\tgreet "a b" c',
      '[script:a] 7\t1\tx\tnil\tGREET x',
      '[script:a] 0\t0\tnil\tnil\tgreet',
    ])
  })

  it('take any arguments before the commands of a console variable of their name', async () => {
    const proc = await createProcess()
    const { manager } = proc
    start(proc, 'a', {
      'main.lua': `RegisterCommand('foo', function(_, args) print('foo', #args) end, false)`,
    })
    run(manager, 'set foo 1', 'system.console')
    run(manager, 'foo')
    run(manager, 'foo 2')
    expect(proc.take()).toEqual(['[script:a] foo\t0', '[script:a] foo\t1'])
    expect(manager.console.variables.find('foo')?.value).toBe('1')
  })

  it('check their arguments', async () => {
    const proc = await createProcess()
    expect(
      start(proc, 'a', {
        'main.lua': `print(pcall(RegisterCommand, nil, function() end, false))
print(pcall(RegisterCommand, 'greet', nil, false))
print(pcall(GetResourceCommands, nil))`,
      }),
    ).toEqual(
      [
        ['5fa79b0f', 0],
        ['5fa79b0f', 1],
        ['97628584', 0],
      ].flatMap(([hash, index]) => {
        const error = `native 00000000${hash}: Argument at index ${index} was null.`
        return [`[citizen-scripting-core] script error in ${error}`, `[script:a] false\t${error}`]
      }),
    )
    expect(proc.manager.console.commands.has('greet')).toBe(false)
  })

  it('let the resource and, unless restricted, everyone run them', async () => {
    const proc = await createProcess()
    const { manager } = proc
    start(proc, 'a', {
      'main.lua': `RegisterCommand('open', function() print('open') end, false)
RegisterCommand('Secret', function() print('secret') end, true)`,
    })
    expect(entriesOf(manager, 'command.open')).toEqual([
      'resource.a allow',
      'builtin.everyone allow',
    ])
    expect(entriesOf(manager, 'command.secret')).toEqual(['resource.a allow'])
    run(manager, 'open')
    run(manager, 'secret')
    run(manager, 'secret', 'resource.a')
    expect(proc.take()).toEqual([
      '[script:a] open',
      '[cmd] Access denied for command secret.',
      '[script:a] secret',
    ])
  })

  it('call the last function registered by their name, from the handler first registered', async () => {
    const proc = await createProcess()
    const { manager } = proc
    start(proc, 'a', { 'main.lua': `RegisterCommand('greet', function() print('a') end, false)` })
    start(proc, 'b', {
      'main.lua': `RegisterCommand('greet', function() print('b') end, true)
RegisterCommand('Greet', function() print('B') end, true)`,
    })
    run(manager, 'greet')
    expect(proc.take()).toEqual(['[script:b] b'])
    expect(manager.console.commands.list.filter(({ name }) => name === 'greet')).toEqual([
      { name: 'greet', resource: 'a', arity: -1 },
    ])
    expect(entriesOf(manager, 'command.greet')).toEqual([
      'resource.a allow',
      'builtin.everyone allow',
    ])
  })

  it('go when their resource stops, with the entries for them', async () => {
    const proc = await createProcess()
    const { manager } = proc
    const a = proc.add('a', {
      'main.lua': `RegisterCommand('greet', function() print('greet') end, false)`,
    })
    a.start()
    run(manager, 'add_ace builtin.everyone command.greet allow', 'system.console')
    run(manager, 'add_ace builtin.everyone command.greet deny', 'system.console')
    a.stop()
    proc.take()
    run(manager, 'greet', 'system.console')
    expect(proc.take()).toEqual(['[cmd] No such command greet.'])
    expect(entriesOf(manager, 'command.greet')).toEqual(['builtin.everyone deny'])
    // The denial stays, and trumps the entries of the command once it is back.
    a.start()
    run(manager, 'greet')
    run(manager, 'remove_ace builtin.everyone command.greet deny', 'system.console')
    run(manager, 'greet')
    expect(proc.take().slice(-2)).toEqual([
      '[cmd] Access denied for command greet.',
      '[script:a] greet',
    ])
  })

  it('last through the onResourceStop of their resource', async () => {
    const proc = await createProcess()
    const a = proc.add('a', {
      'main.lua': `RegisterCommand('greet', function() print('greet') end, false)
AddEventHandler('onResourceStop', function(name)
  if name == GetCurrentResourceName() then ExecuteCommand('greet') end
end)`,
    })
    a.start()
    proc.take()
    a.stop()
    expect(proc.take()).toEqual(['[script:a] greet', '[resources] Stopping resource a'])
  })

  it('are listed with those of the console, by resource', async () => {
    const proc = await createProcess()
    start(proc, 'b', { 'main.lua': `RegisterCommand('two', function() end, false)` })
    expect(
      start(proc, 'a', {
        'main.lua': `RegisterCommand('one', function() end, false)
for _, command in ipairs(GetRegisteredCommands()) do
  if command.name == 'one' or command.name == 'set' then
    print(command.name, command.resource, command.arity)
  end
end
local mine = GetResourceCommands('a')
print(#mine, mine[1].name, #GetResourceCommands('internal'), #GetResourceCommands('nope'))`,
      }),
    ).toEqual(['[script:a] one\ta\t-1', '[script:a] set\tinternal\t2', '[script:a] 1\tone\t0\t0'])
  })

  it('run from scripts as their resource, up to a NUL', async () => {
    const proc = await createProcess()
    const { manager } = proc
    run(manager, 'add_ace resource.b command.set allow', 'system.console')
    expect(
      start(proc, 'a', {
        'main.lua': `ExecuteCommand('set fromA 1')
print(pcall(ExecuteCommand, nil))`,
      }),
    ).toEqual([
      '[cmd] Access denied for command set.',
      '[citizen-scripting-core] script error in native 00000000561c060b: Argument at index 0 was null.',
      '[script:a] false\tnative 00000000561c060b: Argument at index 0 was null.',
    ])
    start(proc, 'b', { 'main.lua': `ExecuteCommand('set fromB "1 2"\\0 ignored')` })
    expect(manager.console.variables.find('fromA')).toBeUndefined()
    expect(manager.console.variables.find('fromB')?.value).toBe('1 2')
  })
})
