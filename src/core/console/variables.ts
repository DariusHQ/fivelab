import { compareUtf8, stoull, stricmpKey } from '../libc.ts'
import type { Commands, ConsoleOutput } from './commands.ts'
import type { Security } from './security.ts'

/** The flags of console variables, as FiveM's ConsoleVariableFlags. */
export const VariableFlags = {
  none: 0,
  /** Saved in the user's configuration. */
  archive: 0x1,
  modified: 0x2,
  /** Public server information. */
  serverInfo: 0x4,
  /** Set by the server, which clients do not let their console set. */
  replicated: 0x8,
  readOnly: 0x10,
  /** Not set by the server on clients. */
  userPref: 0x20,
  /** Not set by commands. */
  internal: 0x40,
  /** Not read by scripts. */
  scriptRestricted: 0x80,
} as const

/** The types of the values of console variables: those of FiveM's ConVar<T> that FiveLab has. */
export type VariableType = 'string' | 'int' | 'bool'

/** A value of a console variable of a type. */
export type VariableValue<T extends VariableType = VariableType> = T extends 'string'
  ? string
  : T extends 'int'
    ? number
    : boolean

/** What console variables need of their console. */
export interface VariablesHost {
  readonly commands: Commands
  readonly security: Security
  readonly output: ConsoleOutput
  /** Whether the console is a server's, whose variables differ from clients'. */
  readonly server: boolean
  /** Adds text to the console's buffer of commands to run, as FiveM's AddToBuffer does. */
  addToBuffer(text: string): void
}

interface Entry {
  readonly name: string
  flags: number
  readonly defaultFlags: number
  readonly variable: Variable
  readonly token: number
}

/**
 * The console variables of a console, as FiveM's ConsoleVariableManager
 * keeps them, by name as _stricmp compares names. Its commands set them:
 * set, seta for archived variables, sets for server information on
 * servers, and setr for replicated variables, which create string
 * variables, and toggle, which switches a variable between two values, and
 * vstr, +vstr and -vstr, which run the commands a variable holds.
 *
 * Each variable also has commands of its name: one without arguments that
 * says what it is, and one that sets it.
 */
export class Variables {
  readonly host: VariablesHost
  /** Whether setting read-only variables is refused without a warning. */
  suppressReadOnlyWarning = false
  /** The entries, ordered by name as _stricmp orders names. */
  readonly #entries: Entry[] = []
  readonly #listeners = new Map<number, (name: string) => void>()
  #nextToken = 0
  #nextCookie = 0

  constructor(host: VariablesHost) {
    this.host = host
    const { commands } = host
    const set = (flags: number) => (name: string, value: string) => this.#set(name, value, flags)
    commands.add('set', ['string', 'string'], set(VariableFlags.none))
    commands.add('seta', ['string', 'string'], set(VariableFlags.archive))
    if (host.server) commands.add('sets', ['string', 'string'], set(VariableFlags.serverInfo))
    commands.add('setr', ['string', 'string'], set(VariableFlags.replicated))
    commands.add('toggle', ['string'], (name) => this.#toggle(name, '1', '0'))
    commands.add('toggle', ['string', 'string', 'string'], (name, first, second) =>
      this.#toggle(name, first, second),
    )
    const run = (name: string) => {
      const variable = this.find(name)
      if (variable !== undefined) host.addToBuffer(`${variable.value}\n`)
    }
    commands.add('vstr', ['string'], run)
    commands.add('+vstr', ['string', 'string'], (hold) => run(hold))
    commands.add('-vstr', ['string', 'string'], (_hold, release) => run(release))
  }

  /** The variable named `name`, as _stricmp compares names, if there is one. */
  find(name: string): Variable | undefined {
    return this.#find(name)?.variable
  }

  /**
   * Registers `variable` by `name` with `flags`, in place of the variable
   * of that name, and returns the token that unregisters it.
   */
  register(name: string, flags: number, variable: Variable): number {
    const old = this.#find(name)
    if (old !== undefined) this.#drop(old, variable)
    const token = this.#nextToken++
    const key = stricmpKey(name)
    let index = this.#entries.length
    while (index > 0 && compareUtf8(key, stricmpKey(this.#entries[index - 1]!.name)) < 0) index--
    this.#entries.splice(index, 0, { name, flags, defaultFlags: flags, variable, token })
    return token
  }

  unregister(token: number): void {
    const entry = this.#entries.find((e) => e.token === token)
    if (entry !== undefined) this.#drop(entry)
  }

  /** Unregisters the first variable named exactly `name`, as FiveM's Unregister by name does. */
  unregisterName(name: string): void {
    const entry = this.#entries.find((e) => e.name === name)
    if (entry !== undefined) this.#drop(entry)
  }

  /**
   * A variable of `type` by `name`, as FiveM's CreateVariableEntry makes
   * them: the variable of that name if it is of that type, or a new one with
   * its value, or a new one with `defaultValue`. Register it to keep it.
   */
  create<T extends VariableType>(name: string, type: T, defaultValue: VariableValue<T>): Variable {
    const old = this.find(name)
    if (old?.type === type) return old
    const variable = new Variable(this, name, type, defaultValue)
    if (old !== undefined) variable.set(old.value)
    return variable
  }

  /**
   * Defines a variable of FiveM's, as its ConVar<T> does: it creates the
   * variable and registers it with `flags`.
   */
  define<T extends VariableType>(
    name: string,
    flags: number,
    type: T,
    defaultValue: VariableValue<T>,
  ): Variable {
    const variable = this.create(name, type, defaultValue)
    this.register(name, flags, variable)
    return variable
  }

  flagsOf(name: string): number {
    return this.#find(name)?.flags ?? 0
  }

  defaultFlagsOf(name: string): number {
    return this.#find(name)?.defaultFlags ?? 0
  }

  addFlags(name: string, flags: number): void {
    const entry = this.#find(name)
    if (entry !== undefined) entry.flags |= flags
  }

  removeFlags(name: string, flags: number): void {
    const entry = this.#find(name)
    if (entry !== undefined) entry.flags &= ~flags
  }

  /**
   * The variables with any of the flags of `mask`, by name, with their
   * flags, or all of them when the mask is -1, as FiveM's ForAllVariables
   * gives them.
   */
  list(mask = -1): { name: string; flags: number; variable: Variable }[] {
    return this.#entries
      .filter(({ flags }) => (flags & mask) !== 0 || (flags === 0 && mask === -1))
      .map(({ name, flags, variable }) => ({ name, flags, variable }))
  }

  /** Calls `listener` with the names of variables whose values change, and returns its cookie. */
  watch(listener: (name: string) => void): number {
    const cookie = this.#nextCookie++
    this.#listeners.set(cookie, listener)
    return cookie
  }

  unwatch(cookie: number): void {
    this.#listeners.delete(cookie)
  }

  /**
   * Marks a variable modified and tells the listeners, as FiveM's
   * MarkConsoleVarModified does, including those that listeners add, but
   * not those they remove.
   */
  markModified(name: string): void {
    this.addFlags(name, VariableFlags.modified)
    for (const listener of this.#listeners.values()) listener(name)
  }

  #find(name: string): Entry | undefined {
    const key = stricmpKey(name)
    return this.#entries.find((entry) => stricmpKey(entry.name) === key)
  }

  /**
   * Takes an entry out, and with it the commands of its variable, unless
   * the variable stays as `kept`. FiveM drops a variable with the last
   * reference to it, which FiveLab takes its entry to be.
   */
  #drop(entry: Entry, kept?: Variable): void {
    this.#entries.splice(this.#entries.indexOf(entry), 1)
    if (entry.variable !== kept) entry.variable.dispose()
  }

  /** What set and its siblings do, which add `flags` to the variable they set. */
  #set(name: string, value: string, flags: number): void {
    const entry = this.#find(name)
    if (entry !== undefined) {
      // Variables that cannot be set keep their flags.
      if (entry.variable.set(value)) entry.flags |= flags
      return
    }
    const variable = this.create(name, 'string', '')
    this.register(name, VariableFlags.modified | flags, variable)
    variable.set(value)
  }

  #toggle(name: string, first: string, second: string): void {
    const variable = this.find(name)
    if (variable === undefined) return
    // FiveM takes booleans for numbers.
    const value =
      variable.value === 'true' ? '1' : variable.value === 'false' ? '0' : variable.value
    variable.set(value === first ? second : first)
  }
}

/** The names of the flags that FiveM's console says variables have, in its order. */
const FLAG_NAMES: [number, string][] = [
  [VariableFlags.archive, 'Archive'],
  [VariableFlags.modified, 'Modified'],
  [VariableFlags.serverInfo, 'ServerInfo'],
  [VariableFlags.replicated, 'Replicated'],
  [VariableFlags.readOnly, 'ReadOnly'],
  [VariableFlags.internal, 'Internal'],
  [VariableFlags.scriptRestricted, 'ScriptRestricted'],
]

/**
 * A console variable, as FiveM's ConsoleVariableEntry<T>: a value of its
 * type, which commands and scripts read and write as strings.
 */
export class Variable<T extends VariableType = VariableType> {
  readonly name: string
  readonly type: T
  readonly defaultValue: VariableValue<T>
  readonly #variables: Variables
  #value: VariableValue<T>
  /** The value before a server set it, which clients go back to. */
  #offlineValue: VariableValue<T>
  #range: [min: number, max: number] | undefined
  readonly #tokens: number[]

  constructor(variables: Variables, name: string, type: T, defaultValue: VariableValue<T>) {
    this.#variables = variables
    this.name = name
    this.type = type
    this.defaultValue = defaultValue
    this.#value = defaultValue
    this.#offlineValue = defaultValue
    const { commands } = variables.host
    this.#tokens = [
      commands.add(name, [], () => this.#describe()),
      commands.register(name, 'internal', (call) => this.#command(call), 1),
    ]
  }

  /** The value as a string, as FiveM unparses values. */
  get value(): string {
    return unparse(this.#value)
  }

  get rawValue(): VariableValue<T> {
    return this.#value
  }

  get offlineValue(): string {
    return unparse(this.#offlineValue)
  }

  saveOfflineValue(): void {
    this.#offlineValue = this.#value
  }

  /** Limits the values of an int variable to a range, as FiveM's SetConstraints does. */
  setRange(min: number, max: number): void {
    this.#range = [min, max]
  }

  /**
   * Sets the value from a string, as FiveM's SetValue does: unless the
   * variable is internal or read-only, and only to a value of its type.
   * Returns whether it did.
   */
  set(text: string): boolean {
    const flags = this.#variables.flagsOf(this.name)
    const { output } = this.#variables.host
    if (flags & VariableFlags.internal) {
      output.printWarning('cmd', `'${this.name}' is an internal ConVar and cannot be changed.\n`)
      return false
    }
    if (flags & VariableFlags.readOnly) {
      if (!this.#variables.suppressReadOnlyWarning) {
        output.printWarning(
          'cmd',
          `'${this.name}' is read only. Try using \`+set\` in the command line.\n`,
        )
      }
      return false
    }
    const value = parse(this.type, text)
    return value !== undefined && this.setRaw(value)
  }

  /**
   * Sets the value, as FiveM's SetRawValue does: within the variable's
   * range, and on clients, for replicated variables, only by code that may
   * access builtin.setReplicated. Returns whether it did.
   */
  setRaw(value: VariableValue<T>): boolean {
    const { output, security, server } = this.#variables.host
    if (this.#range !== undefined && typeof value === 'number') {
      const [min, max] = this.#range
      if (value > max || value < min) {
        const bound = value > max ? `at most ${max}` : `at least ${min}`
        output.print('cmd', `Value out of range (${value}) - should be ${bound}\n`)
        return false
      }
    }
    if (!server && this.#variables.flagsOf(this.name) & VariableFlags.replicated) {
      if (!security.check('builtin.setReplicated')) {
        output.print(
          'cmd',
          `Cannot set server-replicated ConVar ${this.name} from client console.\n`,
        )
        return false
      }
    }
    const old = this.#value
    this.#value = value
    if (old !== value) this.#variables.markModified(this.name)
    return true
  }

  /** Unregisters the commands of the variable. */
  dispose(): void {
    for (const token of this.#tokens) this.#variables.host.commands.unregister(token)
  }

  /** What the command of the variable's name says without arguments. */
  #describe(): void {
    const flags = this.#variables.flagsOf(this.name)
    const names = FLAG_NAMES.filter(([flag]) => flags & flag).map(([, name]) => `${name} `)
    this.#variables.host.output.print(
      'cmd',
      ` "${this.name}" is "${this.value}"\n default: "${unparse(this.defaultValue)}" - flags( ${names.join('')})\n type: ${this.type}\n`,
    )
  }

  /** The command of the variable's name with a value, which sets it. */
  #command(call: { readonly args: readonly string[]; error: string }): boolean {
    if (call.args.length !== 1) {
      call.error += `Argument count mismatch (passed ${call.args.length}, wanted 1)\n`
      return false
    }
    const value = parse(this.type, call.args[0]!)
    if (value === undefined) {
      call.error += `Could not convert argument 0 (${call.args[0]}) to ${this.type}\n`
      return false
    }
    const flags = this.#variables.flagsOf(this.name)
    const { output } = this.#variables.host
    if (flags & VariableFlags.internal) {
      output.printWarning('cmd', `'${this.name}' is an internal ConVar and cannot be changed.\n`)
    } else if (flags & VariableFlags.readOnly) {
      if (!this.#variables.suppressReadOnlyWarning) {
        output.printWarning(
          'cmd',
          `'${this.name}' is read only. Try using \`+set\` in the command line, or prefixing the command with \`set\` in the server startup script.\n`,
        )
      }
    } else {
      this.setRaw(value)
    }
    return true
  }
}

/** A value as FiveM unparses it: ints in decimal, and booleans as true or false. */
function unparse(value: VariableValue): string {
  return String(value)
}

/**
 * A value of `type` from a string, as FiveM parses arguments, or undefined
 * if it is none: ints as std::stoull reads them, cut to 32 bits, and
 * booleans as true or false in any case, or else as whether a number they
 * start with is not 0.
 */
function parse<T extends VariableType>(type: T, text: string): VariableValue<T> | undefined {
  if (type === 'string') return text as VariableValue<T>
  if (type === 'int') {
    const value = stoull(text)
    return (value === undefined ? undefined : Number(BigInt.asIntN(32, value))) as
      VariableValue<T> | undefined
  }
  const word = stricmpKey(text)
  if (word === 'true' || word === 'false') return (word === 'true') as VariableValue<T>
  return ((stoull(text) ?? 0n) !== 0n) as VariableValue<T>
}
