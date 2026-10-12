import { describe, expect, it } from 'vitest'

import { createProcess, runCommand, startResource } from './helpers.ts'

describe('Access natives', () => {
  it('check access as the principals the code runs as, or as everyone', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(IsAceAllowed('command.help'), IsAceAllowed('COMMAND.HELP'), IsAceAllowed('command.quit'))
RegisterCommand('check', function(_, args) print(IsAceAllowed(args[1])) end, false)
ExecuteCommand('check command.check')
ExecuteCommand('check command.quit')`,
      }),
    ).toEqual(['[script:a] 1\t1\tfalse', '[script:a] 1', '[script:a] false'])
    runCommand(proc.manager, 'check command.quit', 'system.console')
    runCommand(proc.manager, 'check command.quit')
    expect(proc.take()).toEqual(['[script:a] 1', '[script:a] false'])
  })

  it('check access as a principal alone', async () => {
    const proc = await createProcess()
    const { manager } = proc
    runCommand(manager, 'add_principal identifier.x group.admin', 'system.console')
    runCommand(manager, 'add_ace group.admin command allow', 'system.console')
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(IsPrincipalAceAllowed('system.console', 'command'))
RegisterCommand('check', function(_, args) print(IsPrincipalAceAllowed(args[1], args[2])) end, false)`,
      }),
    ).toEqual(['[script:a] 1'])
    for (const principal of ['builtin.everyone', 'IDENTIFIER.X', 'group.admin', 'identifier.y']) {
      runCommand(manager, `check ${principal} command.quit`, 'system.console')
    }
    expect(proc.take()).toEqual([
      '[script:a] false',
      '[script:a] 1',
      '[script:a] 1',
      '[script:a] false',
    ])
  })

  it('check their arguments', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(pcall(IsAceAllowed, nil))
print(pcall(IsPrincipalAceAllowed, nil, 'command'))
print(pcall(IsPrincipalAceAllowed, 'system.console', nil))`,
      }),
    ).toEqual(
      [
        ['7ebb9929', 0],
        ['37cf52ce', 0],
        ['37cf52ce', 1],
      ].flatMap(([hash, index]) => {
        const error = `native 00000000${hash}: Argument at index ${index} was null.`
        return [`[citizen-scripting-core] script error in ${error}`, `[script:a] false\t${error}`]
      }),
    )
  })
})
