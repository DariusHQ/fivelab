import { describe, expect, it } from 'vitest'

import { ConsoleContext } from '../../src/core/console/context.ts'
import { addPrinterCommands, ChannelAction, Printer } from '../../src/core/console/printer.ts'
import { Security } from '../../src/core/console/security.ts'
import { VariableFlags } from '../../src/core/console/variables.ts'

/** A printer with its commands in the default console, which writes "[channel] text". */
function createPrinter(before: string[] = []) {
  const written: string[] = []
  const printer = new Printer((channel, text) => written.push(`[${channel}] ${text}`))
  const security = new Security()
  security.addEntry('system.console', 'command', 'allow')
  const context = new ConsoleContext({ security, output: printer, server: true, clock: () => 0 })
  const run = (line: string) => security.runAs('system.console', () => context.execute(line))
  for (const line of before) run(line)
  addPrinterCommands(context, printer)
  return { printer, context, written, run }
}

describe('Printer', () => {
  it('prints text on channels, with NULs shown as <\\0>', () => {
    const { printer, written } = createPrinter()
    printer.print('script:a', 'a\0b\0\n')
    printer.print('cmd', '')
    expect(written).toEqual(['[script:a] a^5<\\0>^7b^5<\\0>^7\n', '[cmd] '])
  })

  it('prints warnings and errors with their color ended before the line breaks at their end', () => {
    const { printer, written } = createPrinter()
    printer.printWarning('x', 'careful\n\n')
    printer.printError('x', 'bad\nthing')
    expect(written).toEqual(['[x] ^3Warning: careful^7\n\n', '[x] ^1Error: bad\nthing^7'])
  })

  it('prints in developer mode only while developer is above 0', () => {
    const { printer, context, written, run } = createPrinter()
    expect(context.variables.flagsOf('developer')).toBe(
      VariableFlags.archive | VariableFlags.userPref,
    )
    printer.printDeveloper('x', 'a\n')
    run('developer 1')
    expect(printer.developer).toBe(1)
    printer.printDeveloper('x', 'b\n')
    run('developer -1')
    printer.printDeveloper('x', 'c\n')
    expect(written).toEqual(['[x] b\n'])
    const before = createPrinter(['set developer 3'])
    expect(before.printer.developer).toBe(3)
    expect(before.context.variables.watch(() => {})).toBe(0)
  })

  it('keeps what it prints on the channels of filters from the console', () => {
    const { printer, written, run } = createPrinter()
    run('con_addChannelFilter "script:* Citizen-scripting-core+cmd" drop')
    run('con_addChannelFilter a.b noprint')
    run('con_addChannelFilter x(y)? drop')
    run('con_addChannelFilter É drop')
    run('con_addChannelFilter seen none')
    const channels = [
      'script:a',
      'script:',
      'SCRIPT:B',
      'citizen-scripting-core',
      'cmd',
      'cmdx',
      'xscript:a',
      'script',
      'a.b',
      'axb',
      'x(y)?',
      'x',
      'É',
      'é',
      'seen',
    ]
    for (const channel of channels) printer.print(channel, 'text')
    expect(written).toEqual(
      ['cmdx', 'xscript:a', 'script', 'axb', 'x', 'é', 'seen'].map((c) => `[${c}] text`),
    )
  })

  it('drops what filters print in developer mode only unless developer is 0', () => {
    const { printer, written, run } = createPrinter()
    run('con_addChannelFilter debug devonly')
    printer.print('debug', 'a')
    run('developer 2')
    printer.print('debug', 'b')
    run('developer -1')
    printer.print('debug', 'c')
    run('con_addChannelFilter debug noprint')
    printer.print('debug', 'd')
    expect(written).toEqual(['[debug] b', '[debug] c'])
  })

  it('adds, replaces and removes filters by pattern and action, which it lists in that order', () => {
    const { printer, written, run } = createPrinter()
    const smile = String.fromCodePoint(0x1f600)
    const bang = String.fromCharCode(0xff01)
    run('con_addChannelFilter b drop')
    run('con_addChannelFilter a NoPrint')
    run('con_addChannelFilter b devonly')
    run('con_addChannelFilter b DROP')
    run('con_addChannelFilter a whatever')
    run('con_addChannelFilter B drop')
    printer.addFilter(smile, ChannelAction.drop)
    printer.addFilter(bang, ChannelAction.drop)
    run('con_channelFilters')
    run('con_removeChannelFilter b drop')
    run('con_removeChannelFilter a nope')
    run('con_removeChannelFilter c drop')
    expect(written).toEqual(
      [
        'B: drop',
        'a: none',
        'a: noprint',
        'b: devonly',
        'b: drop',
        `${bang}: drop`,
        `${smile}: drop`,
      ].map((line) => `[cmd]   ${line}\n`),
    )
    expect(printer.filters).toEqual([
      { pattern: 'B', action: ChannelAction.drop },
      { pattern: 'a', action: ChannelAction.noPrint },
      { pattern: 'b', action: ChannelAction.devOnly },
      { pattern: bang, action: ChannelAction.drop },
      { pattern: smile, action: ChannelAction.drop },
    ])
  })
})
