import { compareUtf8, stoull, stricmpKey } from '../libc.ts'
import type { Security } from './security.ts'
import { decodeUtf8, tokenize } from './tokenize.ts'

/** A command as it runs, as FiveM's ConsoleExecutionContext has it. */
export interface CommandCall {
  readonly args: readonly string[]
  /**
   * Whom the command runs for, as FiveM's context reference names them: the
   * net id of a client that ran it, or empty for the console and scripts.
   */
  readonly source: string
  /** What to print when no handler of the command takes its arguments. */
  error: string
}

/** Runs a command if it takes the arguments of the call, and returns whether it did. */
export type CommandHandler = (call: CommandCall) => boolean

/** A handler of a command, as FiveM's GetRegisteredCommands lists them. */
export interface CommandInfo {
  readonly name: string
  readonly resource: string
  /** How many arguments the handler takes, or -1 for any number. */
  readonly arity: number
}

/** Where a console prints. */
export interface ConsoleOutput {
  /** Prints text on a channel, as FiveM's console::Printf does. */
  print(channel: string, text: string): void
  /** Prints a warning on a channel, as FiveM's console::PrintWarning does. */
  printWarning(channel: string, text: string): void
}

interface Entry extends CommandInfo {
  /** The name as _stricmp compares it. */
  readonly key: string
  readonly handler: CommandHandler
  readonly token: number
}

/**
 * The commands of a console, as FiveM's ConsoleCommandManager keeps them: a
 * command may have several handlers, which it tries in the order they were
 * registered until one takes the arguments. Names match as _stricmp
 * matches them, which ignores the case of ASCII letters and what follows a
 * NUL, and the commands are listed in that order.
 */
export class Commands {
  readonly #security: Security
  readonly #output: ConsoleOutput
  readonly #fallback: Commands | undefined
  readonly #entries: Entry[] = []
  #nextToken = 0
  #rawCommand = ''

  /** Commands that this one does not have run in `fallback`, as in FiveM's fallback context. */
  constructor(security: Security, output: ConsoleOutput, fallback?: Commands) {
    this.#security = security
    this.#output = output
    this.#fallback = fallback
  }

  /** The handlers, ordered by name, then as they were registered. */
  get list(): CommandInfo[] {
    return this.#entries.map(({ name, resource, arity }) => ({ name, resource, arity }))
  }

  /**
   * The line of the command that runs, as FiveM's GetRawCommand gives it:
   * that of the last command that the console split, while it runs, and
   * empty after.
   */
  get rawCommand(): string {
    return this.#rawCommand
  }

  /** Registers a handler of the command `name`, and returns the token that unregisters it. */
  register(name: string, resource: string, handler: CommandHandler, arity = -1): number {
    const token = this.#nextToken++
    const key = stricmpKey(name)
    let index = this.#entries.length
    while (index > 0 && compareUtf8(key, this.#entries[index - 1]!.key) < 0) index--
    this.#entries.splice(index, 0, { name, resource, arity, key, handler, token })
    return token
  }

  /**
   * Registers a handler of the command `name` that takes `params`, as
   * FiveM's ConsoleCommand does for its internal commands.
   */
  add<const P extends readonly Param[]>(
    name: string,
    params: P,
    fn: (...values: { [I in keyof P]: ParamValue<P[I]> }) => void,
  ): number {
    return this.register(name, 'internal', overload(params, fn), params.length)
  }

  unregister(token: number): void {
    const index = this.#entries.findIndex((entry) => entry.token === token)
    if (index !== -1) this.#entries.splice(index, 1)
  }

  has(name: string): boolean {
    const key = stricmpKey(name)
    return this.#entries.some((entry) => entry.key === key)
  }

  /**
   * Splits a command line and runs the command it names, as FiveM's
   * ConsoleCommandManager::Invoke does. Lines of bytes are decoded as
   * FiveM does, and lines that do not decode or that name nothing run
   * nothing.
   */
  invoke(line: string | Uint8Array, source = ''): void {
    const text = typeof line === 'string' ? line : decodeUtf8(line)
    if (text === undefined) return
    const [name, ...args] = tokenize(text)
    if (name === undefined) return
    this.#rawCommand = text
    try {
      this.invokeDirect(name, args, source)
    } finally {
      this.#rawCommand = ''
    }
  }

  /**
   * Runs the command `name` with `args`, as FiveM's InvokeDirect does: in
   * the fallback commands if this has no such command, if the code that runs
   * may access command.<name>, until a handler takes the arguments, or
   * printing why the last one did not.
   */
  invokeDirect(name: string, args: readonly string[], source = ''): void {
    const key = stricmpKey(name)
    const handlers = this.#entries.filter((entry) => entry.key === key).map((e) => e.handler)
    if (handlers.length === 0) {
      if (this.#fallback !== undefined) {
        this.#fallback.#rawCommand = this.#rawCommand
        this.#fallback.invokeDirect(name, args, source)
      } else if (source === '') {
        // FiveM prints the name as a C string, which ends at a NUL.
        this.#output.print('cmd', `No such command ${name.split('\0', 1)[0]}.\n`)
      }
      return
    }
    if (!this.#security.check(`command.${name}`)) {
      this.#output.print('cmd', `Access denied for command ${name}.\n`)
      return
    }
    const call: CommandCall = { args, source, error: '' }
    for (const handler of handlers) {
      call.error = ''
      if (handler(call)) return
    }
    this.#output.print('cmd', call.error)
  }
}

/**
 * What a parameter of FiveM's internal commands is: a string, an int, or,
 * last, the rest of the arguments.
 */
export type Param = 'string' | 'int' | 'rest'

/** The value of an argument for a parameter. */
export type ParamValue<P extends Param> = P extends 'string'
  ? string
  : P extends 'int'
    ? number
    : string[]

/**
 * A handler that calls `fn` with arguments converted to `params`, as FiveM
 * makes one from the parameters of a function. It takes as many arguments
 * as there are parameters, unless the last takes the rest of them, and
 * ints as std::stoull reads them, cut to 32 bits.
 */
function overload<const P extends readonly Param[]>(
  params: P,
  fn: (...values: { [I in keyof P]: ParamValue<P[I]> }) => void,
): CommandHandler {
  return (call) => {
    const { args } = call
    if (params.at(-1) !== 'rest' && args.length !== params.length) {
      call.error += `Argument count mismatch (passed ${args.length}, wanted ${params.length})\n`
      return false
    }
    const values: (string | number | string[])[] = []
    for (const [i, param] of params.entries()) {
      if (param === 'rest') {
        values.push(args.slice(i))
      } else if (param === 'string') {
        values.push(args[i]!)
      } else {
        const value = stoull(args[i]!)
        if (value === undefined) {
          // FiveM names the type as MSVC's typeid does.
          call.error += `Could not convert argument ${i} (${args[i]}) to int\n`
          return false
        }
        values.push(Number(BigInt.asIntN(32, value)))
      }
    }
    fn(...(values as { [I in keyof P]: ParamValue<P[I]> }))
    return true
  }
}
