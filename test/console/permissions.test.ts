import { describe, expect, it } from 'vitest'

import { ConsoleContext } from '../../src/core/console/context.ts'
import {
  addConvarPermissionCommands,
  ConvarPermissions,
} from '../../src/core/console/permissions.ts'
import { Security } from '../../src/core/console/security.ts'

describe('ConvarPermissions', () => {
  it('lets anyone read variables that no resource was given permission to read', () => {
    const permissions = new ConvarPermissions()
    expect(permissions.mayRead('secret', 'a')).toBe(true)
    expect(permissions.mayRead('secret', undefined)).toBe(true)
  })

  it('lets only the resources given permission read a variable, by exact names', () => {
    const permissions = new ConvarPermissions()
    permissions.allowRead('a', 'secret')
    permissions.allowRead('b', 'secret')
    const readers = [undefined, 'a', 'b', 'c', 'A'].filter((r) => permissions.mayRead('secret', r))
    expect(readers).toEqual(['a', 'b'])
    expect(permissions.mayRead('Secret', 'c')).toBe(true)
  })
})

describe('addConvarPermissionCommands', () => {
  it('adds add_convar_permission, which gives resources permission to read', () => {
    const security = new Security()
    security.addEntry('system.console', 'command', 'allow')
    const printed: string[] = []
    const output = {
      print: (channel: string, text: string) => printed.push(`[${channel}] ${text}`),
      printWarning: (channel: string, text: string) => printed.push(`[${channel}] warning ${text}`),
      printDeveloper: (channel: string, text: string) => printed.push(`[${channel}] dev ${text}`),
    }
    const context = new ConsoleContext({ security, output, server: true, clock: () => 0 })
    const permissions = new ConvarPermissions()
    addConvarPermissionCommands(context, permissions)
    const run = (line: string) => security.runAs('system.console', () => context.execute(line))
    run('add_convar_permission a read secret')
    run('add_convar_permission a write other')
    run('add_convar_permission a READ upper')
    run('add_convar_permission a read')
    expect(permissions.mayRead('secret', 'b')).toBe(false)
    expect(permissions.mayRead('secret', 'a')).toBe(true)
    expect(permissions.mayRead('other', 'b')).toBe(true)
    expect(permissions.mayRead('upper', 'b')).toBe(true)
    expect(printed).toEqual(['[cmd] Argument count mismatch (passed 2, wanted 3)\n'])
  })
})
