import { compareUtf8, lowerAscii } from '../libc.ts'
import { hashString } from '../natives/names.ts'
import type { ConsoleOutput } from './commands.ts'
import type { ConsoleContext } from './context.ts'
import { VariableFlags } from './variables.ts'

/**
 * What FiveM's channel filters do with the text printed on the channels
 * they match: nothing, keep it from the console, drop it unless in
 * developer mode, or drop it.
 */
export const ChannelAction = {
  none: 0,
  noPrint: 1,
  devOnly: 2,
  drop: 4,
} as const

/** A channel filter, as FiveM's con_addChannelFilter adds them. */
export interface ChannelFilter {
  /** The channels it matches: names in any case, with * for any text, and spaces or + between them. */
  readonly pattern: string
  readonly action: number
}

interface Filter extends ChannelFilter {
  readonly regex: RegExp
}

/**
 * What FiveM's console prints, as console::Printf and its siblings print
 * it: text on a channel, which goes to the console of the process unless
 * the filters of the channel keep it from there.
 */
export class Printer implements ConsoleOutput {
  /** The developer mode, as FiveM's developer variable sets it: on above 0. */
  developer = 0
  readonly #write: (channel: string, text: string) => void
  /** The filters, ordered by pattern as C++ orders strings, then by action. */
  readonly #filters: Filter[] = []

  /** A printer that writes what reaches the console of the process with `write`. */
  constructor(write: (channel: string, text: string) => void) {
    this.#write = write
  }

  get filters(): ChannelFilter[] {
    return this.#filters.map(({ pattern, action }) => ({ pattern, action }))
  }

  print(channel: string, text: string): void {
    let actions = 0
    const name = lowerAscii(channel)
    for (const { regex, action } of this.#filters) {
      if (regex.test(name)) actions |= action
    }
    // FiveM drops what filters print in developer mode only unless the mode is not 0.
    if (actions & ChannelAction.devOnly && this.developer === 0) actions = ChannelAction.drop
    if (actions & (ChannelAction.drop | ChannelAction.noPrint)) return
    // FiveM shows NULs, which would end what it prints, as <\0>.
    this.#write(channel, text.replaceAll('\0', '^5<\\0>^7'))
  }

  printWarning(channel: string, text: string): void {
    this.print(channel, colored('^3Warning: ', text))
  }

  /** Prints an error on a channel, as FiveM's console::PrintError does. */
  printError(channel: string, text: string): void {
    this.print(channel, colored('^1Error: ', text))
  }

  printDeveloper(channel: string, text: string): void {
    if (this.developer > 0) this.print(channel, text)
  }

  /** Adds a channel filter, in place of the one with its pattern and action. */
  addFilter(pattern: string, action: number): void {
    this.removeFilter(pattern, action)
    let index = this.#filters.length
    while (index > 0 && compareFilters({ pattern, action }, this.#filters[index - 1]!) < 0) index--
    this.#filters.splice(index, 0, { pattern, action, regex: channelRegex(pattern) })
  }

  removeFilter(pattern: string, action: number): void {
    const index = this.#filters.findIndex((f) => f.pattern === pattern && f.action === action)
    if (index !== -1) this.#filters.splice(index, 1)
  }
}

/**
 * Adds the variable and the commands with which FiveM's console printing
 * is managed to the default console of the process, as FiveM adds them:
 * developer, which turns developer mode on, and con_addChannelFilter,
 * con_removeChannelFilter and con_channelFilters, which add, remove and
 * list channel filters.
 */
export function addPrinterCommands(context: ConsoleContext, printer: Printer): void {
  const { commands, variables } = context
  const flags = VariableFlags.archive | VariableFlags.userPref
  variables.define('developer', flags, 'int', 0).track((value) => {
    printer.developer = Number(value)
  })
  commands.add('con_addChannelFilter', ['string', 'string'], (pattern, action) =>
    printer.addFilter(pattern, parseAction(action)),
  )
  commands.add('con_removeChannelFilter', ['string', 'string'], (pattern, action) =>
    printer.removeFilter(pattern, parseAction(action)),
  )
  commands.add('con_channelFilters', [], () => {
    for (const { pattern, action } of printer.filters) {
      printer.print('cmd', `  ${pattern}: ${formatAction(action)}\n`)
    }
  })
}

/** Puts `prefix` before `text`, and ends its color before the line breaks at its end, as FiveM does. */
export function colored(prefix: string, text: string): string {
  const message = prefix + text
  const end = message.replace(/\n+$/, '').length
  return `${message.slice(0, end)}^7${message.slice(end)}`
}

/** The action a filter is added with, as FiveM reads its name: by its hash, so in any case. */
function parseAction(name: string): number {
  const hash = hashString(name)
  if (hash === hashString('noprint')) return ChannelAction.noPrint
  if (hash === hashString('drop')) return ChannelAction.drop
  if (hash === hashString('devonly')) return ChannelAction.devOnly
  return ChannelAction.none
}

function formatAction(action: number): string {
  if (action === ChannelAction.noPrint) return 'noprint'
  if (action === ChannelAction.drop) return 'drop'
  if (action === ChannelAction.devOnly) return 'devonly'
  return 'none'
}

function compareFilters(a: ChannelFilter, b: ChannelFilter): number {
  return compareUtf8(a.pattern, b.pattern) || a.action - b.action
}

/**
 * The channels a filter's pattern matches, as FiveM makes its regex: the
 * pattern as written, but for * for any text and spaces or + between
 * patterns, matched against whole names whose ASCII letters may differ in
 * case, which FiveLab lowercases.
 */
function channelRegex(pattern: string): RegExp {
  const source = pattern
    .replace(/[.^$|()[\]{}?\\]/g, '\\$&')
    .replaceAll(' ', '|')
    .replaceAll('+', '|')
    .replaceAll('*', '.*')
  return new RegExp(`^(?:${lowerAscii(source)})$`)
}
