import { describe, expect, it, vi } from 'vitest'

import { VariableFlags } from '../../src/core/console/index.ts'
import { pack } from '../../src/core/engine/msgpack.ts'
import { createProcess, runCommand, startResource } from './helpers.ts'

describe('Convar natives', () => {
  it('read the variables of the console of scripts as FiveM converts them, or give the default', async () => {
    const proc = await createProcess()
    for (const line of [
      'set text Hello',
      'set num " 42abc"',
      'set yes TRUE',
      'set no false',
      'set big 2147483648',
      'set frac 0.1',
    ]) {
      runCommand(proc.manager, line, 'system.console')
    }
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(GetConvar('TEXT', 'd'), GetConvar('nope', 'd'), GetConvar('nope', 0))
local function ints(default)
  local values = {}
  for i, name in ipairs({ 'num', 'yes', 'no', 'big', 'text', 'frac', 'nope' }) do
    values[i] = tostring(GetConvarInt(name, default))
  end
  return table.concat(values, ' ')
end
print(ints(7))
print(GetConvarBool('yes', false), GetConvarBool('no', true), GetConvarBool('num', false), GetConvarBool('text', true), GetConvarBool('text', false), GetConvarBool('nope', true), GetConvarBool('nope', 256))
print(GetConvarFloat('frac', 1.0), GetConvarFloat('yes', 1.5), GetConvarFloat('num', 1.5), GetConvarFloat('nope', 2.5))`,
      }),
    ).toEqual([
      '[script:a] Hello\td\tnil',
      '[script:a] 42 1 0 7 7 0 7',
      // FiveM reads the first byte of default booleans.
      '[script:a] 1\tfalse\t1\t1\tfalse\t1\tfalse',
      '[script:a] 0.10000000149012\t1.5\t42.0\t2.5',
    ])
  })

  it('read the variables of the default console on clients', async () => {
    const proc = await createProcess({ side: 'client' })
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(GetConvarInt('developer', 7), GetConvar('se_debug', 'd'), GetConvarBool('se_debug', true))`,
      }),
    ).toEqual(['[script:a] 0\tfalse\tfalse'])
  })

  it('give the default for variables that scripts may not read', async () => {
    const proc = await createProcess()
    const { manager } = proc
    manager.console.variables.define('hidden', VariableFlags.scriptRestricted, 'string', 'h')
    runCommand(manager, 'set secret s', 'system.console')
    runCommand(manager, 'add_convar_permission b read secret', 'system.console')
    const main = `print(GetConvar('hidden', 'd'), GetConvar('secret', 'd'), GetConvar('Secret', 'd'))`
    expect(startResource(proc, 'a', { 'main.lua': main })).toEqual(['[script:a] d\td\ts'])
    expect(startResource(proc, 'b', { 'main.lua': main })).toEqual(['[script:b] d\ts\ts'])
  })

  it('call listeners with the names of the variables that change and match', async () => {
    const proc = await createProcess()
    const { manager } = proc
    expect(
      startResource(proc, 'a', {
        'main.lua': `local cookie = AddConvarChangeListener('game*', function(name, value)
  print('game', name, value == '')
end)
print(cookie, AddConvarChangeListener(nil, function(name) print('any', name) end))
RegisterCommand('unlisten', function() RemoveConvarChangeListener(cookie) end, false)`,
      }),
    ).toEqual(['[script:a] 0\t1'])
    runCommand(manager, 'set gameType x', 'system.console')
    runCommand(manager, 'set gameType x', 'system.console')
    runCommand(manager, 'set other 1', 'system.console')
    runCommand(manager, 'unlisten')
    runCommand(manager, 'set gametype y', 'system.console')
    expect(proc.take()).toEqual([
      '[script:a] game\tgameType\ttrue',
      '[script:a] any\tgameType',
      '[script:a] any\tother',
      // Listeners hear of variables by the names they were created with.
      '[script:a] any\tgameType',
    ])
  })

  it('stop listening when their resource stops', async () => {
    const proc = await createProcess()
    startResource(proc, 'b', {
      'main.lua': `AddConvarChangeListener('*', function(name)
  print('b', name)
  if name == 'one' then AddConvarChangeListener('*', function(later) print('added', later) end) end
end)`,
    })
    const a = proc.add('a', { 'main.lua': `AddConvarChangeListener('*', function() end)` })
    a.start()
    a.stop()
    proc.take()
    // The listener of b is the last one again, so the one it adds misses the change.
    runCommand(proc.manager, 'set one 1', 'system.console')
    runCommand(proc.manager, 'set two 2', 'system.console')
    expect(proc.take()).toEqual(['[script:b] b\tone', '[script:b] b\ttwo', '[script:b] added\ttwo'])
  })

  it('take cookies after the listener of the NUI console on clients', async () => {
    const proc = await createProcess({ side: 'client' })
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(AddConvarChangeListener('*', function() end))`,
      }),
    ).toEqual(['[script:a] 1'])
  })

  it('skip variables that the code that changes them may not read', async () => {
    const proc = await createProcess()
    const { manager } = proc
    runCommand(manager, 'add_convar_permission b read secret', 'system.console')
    manager.console.variables.define('hidden', VariableFlags.scriptRestricted, 'string', 'h')
    startResource(proc, 'a', {
      'main.lua': `AddConvarChangeListener('*', function(name) print('heard', name) end)
RegisterCommand('set_from_a', function(_, args) SetConvar(args[1], args[2]) end, false)`,
    })
    startResource(proc, 'b', {
      'main.lua': `RegisterCommand('set_from_b', function(_, args) SetConvar(args[1], args[2]) end, false)`,
    })
    runCommand(manager, 'set secret 1', 'system.console')
    runCommand(manager, 'set_from_a secret 2')
    runCommand(manager, 'set_from_b secret 3')
    runCommand(manager, 'hidden x', 'system.console')
    expect(proc.take()).toEqual(['[script:a] heard\tsecret'])
    expect(manager.console.variables.find('secret')?.value).toBe('3')
    expect(manager.console.variables.find('hidden')?.value).toBe('x')
  })

  it('hold the functions of listeners until they stop listening', async () => {
    const proc = await createProcess()
    const { manager } = proc
    const held = vi.spyOn(manager, 'duplicateFunctionReference')
    const a = proc.add('a', {
      'main.lua': `local cookie = AddConvarChangeListener('*', function(name) print('one', name) end)
AddConvarChangeListener('*', function(name) print('two', name) end)
RegisterCommand('unlisten', function() RemoveConvarChangeListener(cookie) end, false)`,
    })
    a.start()
    const [one, two] = held.mock.calls.map(([ref]) => ref)
    proc.take()
    runCommand(manager, 'unlisten')
    manager.invokeFunctionReference(one!, pack(['x']))
    manager.invokeFunctionReference(two!, pack(['x']))
    expect(proc.take()).toEqual([
      `[script:a] Invalid ref call attempt: ${one!.split(':')[2]}`,
      '[script:a] two\tx',
    ])
    a.stop()
    runCommand(manager, 'set gone 1', 'system.console')
    expect(proc.take()).toEqual(['[resources] Stopping resource a'])
  })

  it('set variables of servers as the console', async () => {
    const proc = await createProcess()
    const { manager } = proc
    runCommand(manager, 'add_ace resource.a command deny', 'system.console')
    expect(
      startResource(proc, 'a', {
        'main.lua': `SetConvar('plain', 'p 1')
SetConvarServerInfo('info', 'i')
SetConvarReplicated('replicated', 'r')
SetGameType('Freeroam')
SetMapName('San Andreas')
EnableEnhancedHostSupport(false)
print(GetConvar('sv_enhancedHostSupport', 'd'))
EnableEnhancedHostSupport(true)`,
      }),
    ).toEqual(['[script:a] 0'])
    const { variables } = manager.console
    const values = ['plain', 'info', 'replicated', 'gametype', 'mapname', 'sv_enhancedHostSupport']
    expect(values.map((name) => [variables.find(name)?.value, variables.flagsOf(name)])).toEqual([
      ['p 1', VariableFlags.modified],
      ['i', VariableFlags.modified | VariableFlags.serverInfo],
      ['r', VariableFlags.modified | VariableFlags.replicated],
      ['Freeroam', VariableFlags.modified],
      ['San Andreas', VariableFlags.modified],
      ['1', VariableFlags.modified],
    ])
  })

  it('set no variables on clients', async () => {
    const proc = await createProcess({ side: 'client' })
    expect(
      startResource(proc, 'a', { 'main.lua': `print(SetConvar, SetGameType, GetConvar ~= nil)` }),
    ).toEqual(['[script:a] nil\tnil\ttrue'])
  })

  it('check their arguments', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(pcall(GetConvar, nil, 'd'))
print(pcall(GetConvarInt, nil, 1))
print(pcall(AddConvarChangeListener, '*', nil))
print(pcall(SetConvar, nil, 'x'))
print(pcall(SetConvar, 'x', nil))`,
      }),
    ).toEqual(
      [
        ['6ccd2564', 0],
        ['935c0ab2', 0],
        ['ab7f7241', 1],
        ['341b16d2', 0],
        ['341b16d2', 1],
      ].flatMap(([hash, index]) => {
        const error = `native 00000000${hash}: Argument at index ${index} was null.`
        return [`[citizen-scripting-core] script error in ${error}`, `[script:a] false\t${error}`]
      }),
    )
  })
})
