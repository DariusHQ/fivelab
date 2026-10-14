import { compareUtf8 } from '../libc.ts'
import { hashString } from '../natives/names.ts'
import type { ConsoleOutput } from './commands.ts'
import type { ConsoleContext } from './context.ts'
import { namePattern } from './patterns.ts'
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
  readonly matches: (channel: string) => boolean
}

/** What takes what prints for a while; see Printer.within. */
interface Scope {
  readonly rename: (channel: string) => string
  readonly listener: (text: string) => void
}

/**
 * What FiveM's console prints, as console::Printf and its siblings print
 * it: text on a channel, which goes to the console of the process unless
 * the filters of the channel keep it from there, then to the listeners of
 * what prints unless they drop it.
 */
export class Printer implements ConsoleOutput {
  /** The developer mode, as FiveM's developer variable sets it: on above 0. */
  developer = 0
  readonly #write: (channel: string, text: string) => void
  /** The filters, ordered by pattern as C++ orders strings, then by action. */
  readonly #filters: Filter[] = []
  readonly #listeners: ((channel: string, text: string) => void)[] = []
  readonly #scopes: Scope[] = []

  /** A printer that writes what reaches the console of the process with `write`. */
  constructor(write: (channel: string, text: string) => void) {
    this.#write = write
  }

  get filters(): ChannelFilter[] {
    return this.#filters.map(({ pattern, action }) => ({ pattern, action }))
  }

  print(channel: string, text: string): void {
    for (const { rename } of this.#scopes) channel = rename(channel)
    let actions = 0
    for (const { matches, action } of this.#filters) {
      if (matches(channel)) actions |= action
    }
    // FiveM drops what filters print in developer mode only unless the mode is not 0.
    if (actions & ChannelAction.devOnly && this.developer === 0) actions = ChannelAction.drop
    if (actions & ChannelAction.drop) return
    // FiveM shows NULs, which would end what it prints, as <\0>.
    const shown = text.replaceAll('\0', '^5<\\0>^7')
    if ((actions & ChannelAction.noPrint) === 0) this.#write(channel, shown)
    for (const listener of this.#listeners) listener(channel, shown)
    for (const { listener } of this.#scopes) listener(shown)
  }

  /**
   * Runs `fn` while what prints goes on the channel that `rename` gives for
   * its own, before the filters, and to `listener` as well, unless filters
   * drop it, as FiveM's print filter and print listener contexts take what
   * prints while they last.
   */
  within<T>(rename: (channel: string) => string, listener: (text: string) => void, fn: () => T): T {
    this.#scopes.push({ rename, listener })
    try {
      return fn()
    } finally {
      this.#scopes.pop()
    }
  }

  /**
   * Calls `listener` with what prints after the console and the listeners
   * before it, as FiveM calls its print listeners: with all that filters do
   * not drop, which includes what they keep from the console.
   */
  listen(listener: (channel: string, text: string) => void): void {
    this.#listeners.push(listener)
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
    this.#filters.splice(index, 0, { pattern, action, matches: namePattern(pattern) })
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
