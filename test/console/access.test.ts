import { describe, expect, it } from 'vitest'

import { addAccessCommands } from '../../src/core/console/access.ts'
import { ConsoleContext } from '../../src/core/console/context.ts'
import { Security } from '../../src/core/console/security.ts'

/** The default console of a process, which runs commands as the console, as "[channel] text" prints. */
function createConsole(server = true, before: string[] = []) {
  const security = new Security()
  security.addEntry('system.console', 'command', 'allow')
  const printed: string[] = []
  const output = {
    print: (channel: string, text: string) => printed.push(`[${channel}] ${text}`),
    printWarning: (channel: string, text: string) => printed.push(`[${channel}] warning ${text}`),
    printDeveloper: (channel: string, text: string) =>
      printed.push(`[${channel}] developer ${text}`),
  }
  const context = new ConsoleContext({ security, output, server, clock: () => 0 })
  const run = (line: string) => security.runAs('system.console', () => context.execute(line))
  for (const line of before) run(line)
  addAccessCommands(context)
  return { security, context, printed, run }
}

const ACCESS_COMMANDS = new Set([
  'add_ace',
  'add_principal',
  'list_aces',
  'list_principals',
  'remove_ace',
  'remove_principal',
  'se_debug',
  'test_ace',
])

describe('addAccessCommands', () => {
  it('adds the commands that manage access, those that change it on servers only', () => {
    const names = (server: boolean) =>
      createConsole(server)
        .context.commands.list.map(({ name }) => name)
        .filter((name) => ACCESS_COMMANDS.has(name))
    expect(names(true)).toEqual([
      'add_ace',
      'add_principal',
      'list_aces',
      'list_principals',
      'remove_ace',
      'remove_principal',
      'se_debug',
      'se_debug',
      'test_ace',
    ])
    expect(names(false)).toEqual([
      'list_aces',
      'list_principals',
      'se_debug',
      'se_debug',
      'test_ace',
    ])
    const { context, printed, run } = createConsole(false)
    expect(context.variables.find('se_debug')?.value).toBe('false')
    run('add_ace a b allow')
    expect(printed).toEqual(['[cmd] No such command add_ace.\n'])
  })

  it('changes who may access what, and lists it', () => {
    const { security, printed, run } = createConsole()
    run('add_ace Group.Admin Command allow')
    run('add_ace group.admin command.quit deny')
    run('add_principal Identifier.License:1 group.admin')
    run('test_ace Identifier.License:1 Command.Say')
    run('test_ace identifier.license:1 command.quit')
    run('list_aces')
    run('list_principals')
    run('remove_ace group.admin COMMAND.QUIT deny')
    run('remove_principal identifier.license:1 Group.Admin')
    run('test_ace identifier.license:1 command.say')
    run('list_principals')
    expect(security.entries).toEqual([
      { principal: 'system.console', object: 'command', access: 'allow' },
      { principal: 'group.admin', object: 'command', access: 'allow' },
    ])
    expect(printed).toEqual(
      [
        'Identifier.License:1 -> Command.Say = true',
        'identifier.license:1 -> command.quit = false',
        'system.console -> command = ALLOW',
        'group.admin -> command = ALLOW',
        'group.admin -> command.quit = DENY',
        'identifier.license:1 <- group.admin',
        'identifier.license:1 -> command.say = false',
      ].map((line) => `[security] ${line}\n`),
    )
  })

  it("takes only accesses written allow or deny, and never code's own principals", () => {
    const { security, printed, run } = createConsole()
    run('add_ace a b Allow')
    run('remove_ace system.console command maybe')
    run('add_ace system.console webadmin allow')
    run('remove_ace system.console command allow')
    // FiveM compares the principals that code runs as with the principal as written.
    run('add_ace System.Console webadmin allow')
    expect(security.entries).toEqual([
      { principal: 'system.console', object: 'command', access: 'allow' },
      { principal: 'system.console', object: 'webadmin', access: 'allow' },
    ])
    expect(printed).toEqual(
      [
        "Access type needs to be 'allow' or 'deny'.",
        "Access type needs to be 'allow' or 'deny'.",
        'Changing ones own access is not permitted.',
        'Changing ones own access is not permitted.',
      ].map((line) => `[security] ${line}\n`),
    )
  })

  it('refuses changes to the access of any principal that code runs as', () => {
    const { context, security, printed } = createConsole()
    security.runAs('system.console', () =>
      security.runAs('resource.admin', () => context.execute('add_ace system.console x allow')),
    )
    expect(printed).toEqual(['[security] Changing ones own access is not permitted.\n'])
  })

  it('makes checks print what they find while se_debug is on', () => {
    const { printed, run } = createConsole()
    run('add_ace builtin.everyone command.help allow')
    run('se_debug true')
    run('test_ace someone command.help')
    run('se_debug 0')
    run('test_ace someone command.help')
    expect(printed).toEqual([
      '[security] developer TEST ACL [system.console -> command.test_ace] ACE [system.console command] -> ALLOW\n',
      '[security] TEST ACL [system.console -> command.test_ace] -> ALLOW\n',
      '[security] developer TEST ACL [someone -> command.help] ACE [builtin.everyone command.help] -> ALLOW\n',
      '[security] TEST ACL [someone -> command.help] -> ALLOW\n',
      '[security] someone -> command.help = true\n',
      '[security] developer TEST ACL [system.console -> command.se_debug] ACE [system.console command] -> ALLOW\n',
      '[security] TEST ACL [system.console -> command.se_debug] -> ALLOW\n',
      '[security] someone -> command.help = true\n',
    ])
  })

  it('keeps se_debug as it was set before, without listening to the variables', () => {
    const { context, security } = createConsole(true, ['set se_debug 1'])
    expect(context.variables.find('se_debug')?.rawValue).toBe(true)
    expect(security.debug).toBe(context.output)
    expect(context.variables.watch(() => {})).toBe(0)
  })
})
