import { compareUtf8, stricmpKey } from '../libc.ts'
import { Commands, type ConsoleOutput } from './commands.ts'
import { jsonLength } from './json.ts'
import type { Security } from './security.ts'
import { Variables } from './variables.ts'

export interface ConsoleContextOptions {
  readonly security: Security
  readonly output: ConsoleOutput
  /** Whether the context is a server's. */
  readonly server: boolean
  /** The time in milliseconds, which wait counts. */
  readonly clock: () => number
  /** The context that runs the commands this one does not have. */
  readonly fallback?: ConsoleContext
}

const encoder = new TextEncoder()

/**
 * A console, as FiveM's console::Context: commands, variables, and a
 * buffer of commands to run, which wait pauses. A context runs the
 * commands it does not have in its fallback, as FiveM's server runs those
 * of its process's default context, and lists them with its own in
 * cmdlist.
 */
export class ConsoleContext {
  readonly security: Security
  readonly output: ConsoleOutput
  /** Whether the context is a server's. */
  readonly server: boolean
  readonly commands: Commands
  readonly variables: Variables
  readonly fallback: ConsoleContext | undefined
  readonly #clock: () => number
  #buffer = new Uint8Array(0)
  /** When the buffer runs again after a wait, or undefined when it does not wait. */
  #waitUntil: number | undefined
  #executing = false

  constructor(options: ConsoleContextOptions) {
    const { security, output, server, clock, fallback } = options
    this.security = security
    this.output = output
    this.server = server
    this.fallback = fallback
    this.#clock = clock
    this.commands = new Commands(security, output, fallback?.commands)
    this.variables = new Variables({
      commands: this.commands,
      security,
      output,
      server,
      addToBuffer: (text) => this.addToBuffer(text),
    })
    this.commands.add('wait', ['int'], (ms) => {
      // FiveM starts waits from the time in whole milliseconds.
      this.#waitUntil = (this.#waitUntil ?? Math.trunc(this.#clock())) + ms
    })
    this.commands.add('cmdlist', [], () => this.#listCommands())
  }

  /** Whether the buffer has no commands, and none of them runs, as FiveM's IsBufferEmpty says. */
  get bufferEmpty(): boolean {
    return this.#buffer.length === 0 && !this.#executing
  }

  /** Runs a command line, as FiveM's ExecuteSingleCommand does. */
  execute(line: string | Uint8Array): void {
    this.commands.invoke(line)
  }

  /**
   * Runs the command that `args` name with the arguments that follow, as
   * FiveM's ExecuteSingleCommandDirect does, without splitting a line.
   */
  executeDirect(args: readonly string[]): void {
    const [name, ...rest] = args
    if (name !== undefined) this.commands.invokeDirect(name, rest)
  }

  /** Adds text to the buffer of commands to run, as FiveM's AddToBuffer does. */
  addToBuffer(text: string | Uint8Array): void {
    const bytes = typeof text === 'string' ? encoder.encode(text) : text
    const buffer = new Uint8Array(this.#buffer.length + bytes.length)
    buffer.set(this.#buffer)
    buffer.set(bytes, this.#buffer.length)
    this.#buffer = buffer
  }

  /**
   * Runs the commands of the buffer, as FiveM's ExecuteBuffer does, unless
   * a wait has not ended. Commands end at line breaks, and at semicolons
   * outside quotes and JSON. A command that starts with wait, after
   * whitespace, is the last that runs, and the rest stay for later.
   */
  executeBuffer(): void {
    if (this.#waitUntil !== undefined && this.#waitUntil >= this.#clock()) return
    this.#waitUntil = undefined
    const commands: Uint8Array[] = []
    while (this.#buffer.length > 0) {
      const buffer = this.#buffer
      let end = 0
      let quoted = false
      for (; end < buffer.length; end++) {
        const byte = buffer[end]!
        if (!quoted && (byte === BRACE || byte === BRACKET)) {
          const json = jsonLength(buffer, end)
          if (json !== undefined) {
            end += json - 1
            continue
          }
        }
        if (byte === QUOTE) quoted = !quoted
        if ((!quoted && byte === SEMICOLON) || byte === CR || byte === LF) break
      }
      const command = buffer.subarray(0, end)
      this.#buffer = buffer.subarray(Math.min(end + 1, buffer.length))
      commands.push(command)
      let start = 0
      while (start < command.length && isSpace(command[start]!)) start++
      // FiveM takes any command that starts with wait for one.
      if (String.fromCharCode(...command.subarray(start, start + 4)) === 'wait') break
    }
    this.#executing = true
    try {
      for (const command of commands) this.execute(command)
    } finally {
      this.#executing = false
    }
  }

  /**
   * Lists the commands of the context and its fallback that the code that
   * runs may access, as FiveM's cmdlist does: once by each name, as
   * _stricmp compares names, in that order, with the values of variables.
   */
  #listCommands(): void {
    const names = new Map<string, string>()
    for (const { name } of [...this.commands.list, ...(this.fallback?.commands.list ?? [])]) {
      const key = stricmpKey(name)
      if (!names.has(key)) names.set(key, name)
    }
    const sorted = [...names].sort(([a], [b]) => compareUtf8(a, b))
    for (const [, name] of sorted) {
      if (!this.security.check(`command.${name}`)) continue
      const variable = this.variables.find(name) ?? this.fallback?.variables.find(name)
      const text = variable === undefined ? `${name}\n` : `${name} = ${variable.value}^7\n`
      this.output.print('CmdSystem', text)
    }
  }
}

const LF = 0x0a
const CR = 0x0d
const QUOTE = 0x22
const SEMICOLON = 0x3b
const BRACKET = 0x5b
const BRACE = 0x7b

/** Whether a byte is whitespace, as C's isspace finds it. */
function isSpace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)
}
