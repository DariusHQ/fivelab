import {
  Engine,
  SERVER_FRAME_TIME,
  type FileSystem,
  type HttpClient,
  type NativeContext,
  type Player,
  type PlayerIdentity,
  type ProcessOutput,
} from '../core/engine/index.ts'
import {
  pack,
  packObject,
  unpackObject,
  type MsgpackObject,
  type PackedValue,
} from '../core/engine/msgpack.ts'
import { LuaFatalError, type WatchdogOptions } from '../core/lua/index.ts'
import { defineNative } from '../core/natives/index.ts'
import { UTC } from '../core/scripting/time.ts'
import client from './lua/client.lua?raw'
import harness from './lua/harness.lua?raw'

/** The name of the resource that runs the tests, which projects cannot have one of. */
export const TEST_RESOURCE = 'fiverunner'

/** Milliseconds that a test may take by the clock of its server, unless it gives its own. */
export const DEFAULT_TIMEOUT = 5000

/** Milliseconds since the epoch by the wall clocks of the servers of tests as they start: 2026-01-01 at midnight UTC. */
export const EPOCH = Date.UTC(2026, 0, 1)

/** Interrupts the scripts of tests that run for 5 seconds without returning, which would hang the run. */
const WATCHDOG: WatchdogOptions = { timeoutMs: 5000 }

/** Sends no requests, so that tests do not depend on the network: each fails as if no server took it. */
const offline: HttpClient = async () => ({
  code: 7,
  message: 'FiveRunner sends no HTTP requests in tests',
})

const MANIFEST = `fx_version 'cerulean'
game 'gta5'
server_script 'harness.lua'
client_script 'client.lua'
`

/** A FiveM project, whose resources tests run with. */
export interface Project {
  /** The files of a server, which the runner takes anew for each test, so that tests keep what they write to themselves. */
  files(): FileSystem
  /**
   * The commands that start the project once its server scanned its
   * resources, as the command line of the server would run them, such as
   * exec server.cfg, or ensure and the name of a resource.
   */
  readonly commands: readonly string[]
}

/** A test file, which runs as a server script of the resource that runs the tests. */
export interface TestFile {
  /** Its path in the project, with slashes, which ends in .test.lua. */
  readonly path: string
  readonly source: string | Uint8Array
}

/** What a process printed or reported. */
export interface OutputLine {
  /** server, or the client that printed it: client 1, client 2 and on, in the order they connected. */
  readonly process: string
  /**
   * console for what the process printed on its console, warning for the
   * warnings of Lua, and diagnostic for what FiveRunner noticed of how a
   * resource uses FiveM.
   */
  readonly kind: 'console' | 'warning' | 'diagnostic'
  /** The channel of the console, such as script:name, or the resource that warned or was diagnosed. */
  readonly channel: string
  readonly text: string
}

/** A line of the test file that a failure came through, and the function that was there, if Lua knows its name. */
export interface Frame {
  readonly line: number
  readonly name?: string
}

/** Why a test or a test file failed. */
export interface Failure {
  readonly message: string
  /** The lines of the test file that the failure came through, innermost first. */
  readonly frames: readonly Frame[]
}

export type TestStatus = 'passed' | 'failed' | 'skipped'

export interface TestResult {
  /** The names of the describes that the test is in, outermost first, and its own. */
  readonly names: readonly string[]
  readonly status: TestStatus
  /** What failed in the test and its hooks, in the order they failed. */
  readonly failures: readonly Failure[]
  /** Milliseconds that the test took, by the clock of its server. */
  readonly duration: number
  /** What the processes printed, from the start of the server of the test to its end. */
  readonly output: readonly OutputLine[]
}

export interface FileResult {
  readonly path: string
  readonly tests: readonly TestResult[]
  /** Why the file did not load, if it did not, which leaves it without tests. */
  readonly failure?: Failure
  /** What the processes printed as the file loaded for the runner to collect its tests. */
  readonly output: readonly OutputLine[]
}

export interface RunOptions {
  /** cfxlua.wasm, compiled. */
  readonly cfxlua: WebAssembly.Module
  readonly project: Project
  /** Called with each test as it ends, or as it is skipped. */
  readonly onResult?: (result: TestResult) => void
  /** What interrupts the scripts of tests that run too long without returning: 5 seconds by default. */
  readonly watchdog?: WatchdogOptions
}

/** A test as the harness collected it. */
interface Collected {
  readonly names: readonly string[]
  readonly mode: 'run' | 'skip' | 'only'
  readonly timeout: number | undefined
}

/** What the harness reports once the file loaded: its tests, or why it did not load. */
interface Loaded {
  readonly tests: readonly Collected[]
  readonly failure: Failure | undefined
}

/**
 * What the harness reports once it ran a test: the names of the test, and
 * what failed. Without names, the test file did not load as it had, and
 * what failed says why.
 */
interface Ran {
  readonly names: readonly string[] | undefined
  readonly failures: readonly Failure[]
}

/**
 * Runs the tests of a file, each in a server of its own that starts the
 * project anew: first a server that loads the file to collect its tests,
 * then one for each test that is not skipped, in the order they came.
 * Tests that the file marks with only run alone. Each test fails if it
 * does not end within its timeout, by the clock of its server, which moves
 * only as the runner moves it, as fast as it can.
 */
export async function runFile(file: TestFile, options: RunOptions): Promise<FileResult> {
  if (!file.path.endsWith('.test.lua')) {
    throw new Error(`The paths of test files end in .test.lua, as ${file.path} does not`)
  }
  const world = await World.create(options, file, undefined, loadedOf)
  const loaded = await world.run(DEFAULT_TIMEOUT)
  const output = world.output.lines
  if (loaded === undefined) {
    const message = `the test file did not load within ${DEFAULT_TIMEOUT} ms`
    return { path: file.path, tests: [], failure: world.crash ?? failure(message), output }
  }
  if (loaded.failure !== undefined) {
    return { path: file.path, tests: [], failure: loaded.failure, output }
  }
  const only = loaded.tests.some((test) => test.mode === 'only')
  const results: TestResult[] = []
  for (const [index, test] of loaded.tests.entries()) {
    const skipped = test.mode === 'skip' || (only && test.mode !== 'only')
    const result = skipped
      ? { names: test.names, status: 'skipped' as const, failures: [], duration: 0, output: [] }
      : await runTest(options, file, index + 1, test)
    options.onResult?.(result)
    results.push(result)
  }
  return { path: file.path, tests: results, output }
}

/** Runs the test that is `index`th in the file, from 1, in a server of its own. */
async function runTest(
  options: RunOptions,
  file: TestFile,
  index: number,
  test: Collected,
): Promise<TestResult> {
  const world = await World.create(options, file, index, ranOf)
  const timeout = test.timeout ?? DEFAULT_TIMEOUT
  const ran = await world.run(timeout)
  let failures: readonly Failure[]
  if (ran === undefined) {
    failures = [world.crash ?? failure(`the test did not end within ${timeout} ms`)]
  } else if (ran.names !== undefined && !sameNames(ran.names, test.names)) {
    failures = [failure('the test file has other tests than it had as it first loaded')]
  } else {
    failures = ran.failures
  }
  const status = failures.length === 0 ? 'passed' : 'failed'
  const duration = world.engine.clock.now
  return { names: test.names, status, failures, duration, output: world.output.lines }
}

/** A failure that came through no line of the test file. */
function failure(message: string): Failure {
  return { message, frames: [] }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index])
}

/** A connection that a test asked for: the process of its client, and its player once the client started. */
interface Connection {
  readonly process: string
  player: Player | undefined
}

/** An event that the client of a player got from the network. */
interface Received {
  readonly player: Player
  readonly name: string
  readonly payload: Uint8Array
}

/**
 * A server that started the project, and the resource that runs the
 * tests of a file, with what its processes printed, and what its harness
 * reported, as `parse` reads it.
 */
class World<T> {
  readonly engine: Engine
  readonly output: Output
  readonly #options: RunOptions
  /** The file that the harness loads, and the test it runs, if it runs one. */
  readonly #target: PackedValue
  readonly #parse: (report: unknown) => T
  #report: T | undefined
  /** What the server waits for outside its frames, such as the responses to HTTP requests. */
  readonly #pending: Promise<unknown>[]
  /** What tests asked the runner to do between frames, in the order they asked. */
  readonly #actions: (() => Promise<void> | void)[] = []
  /** The connections that tests asked for, in the order they asked. */
  readonly #connections: Connection[] = []
  readonly #received: Received[] = []
  /** What the server failed with, if it crashed. */
  crash: Failure | undefined

  private constructor(
    engine: Engine,
    output: Output,
    pending: Promise<unknown>[],
    options: RunOptions,
    target: PackedValue,
    parse: (report: unknown) => T,
  ) {
    this.engine = engine
    this.output = output
    this.#pending = pending
    this.#options = options
    this.#target = target
    this.#parse = parse
  }

  /**
   * Starts a server for the tests of `file`: the project, then the
   * resource that runs the tests, which collects them, or runs the
   * `test`th of them.
   */
  static async create<T>(
    options: RunOptions,
    file: TestFile,
    test: number | undefined,
    parse: (report: unknown) => T,
  ): Promise<World<T>> {
    const output = new Output()
    const pending: Promise<unknown>[] = []
    let world: World<T> | undefined
    const call = defineNative(
      { name: 'FIVERUNNER_CALL', result: 'object', params: ['char* method', 'bytes args'] },
      (ctx: NativeContext, method, args) => {
        if (ctx.resource.name !== TEST_RESOURCE) throw new Error('Only the tests may call this')
        // Scripts run once the world is there.
        return world!.#answer(method, args === null ? undefined : plain(unpackObject(args)))
      },
    )
    const engine = await Engine.create({
      cfxlua: options.cfxlua,
      epoch: EPOCH,
      output: ({ name }) => output.of(name),
      server: {
        files: options.project.files(),
        natives: [call],
        timeZone: UTC,
        watchdog: options.watchdog ?? WATCHDOG,
        http: (request) => {
          const response = offline(request)
          pending.push(response)
          return response
        },
      },
    })
    const target = test === undefined ? { file: file.path } : { file: file.path, test }
    world = new World(engine, output, pending, options, target, parse)
    world.#survive(() => {
      const { server } = engine
      server.scanResources()
      for (const command of options.project.commands) {
        server.security.runAs('system.console', () => server.console.commands.invoke(command, ''))
      }
      server.endInitialConfiguration()
      if (server.getResource(TEST_RESOURCE, false) !== undefined) {
        throw new Error(
          `The project has a resource named ${TEST_RESOURCE}, the name of the resource that runs its tests`,
        )
      }
      // Tests may run whatever commands the console may.
      server.security.addEntry(`resource.${TEST_RESOURCE}`, 'command', 'allow')
      server
        .addResource(TEST_RESOURCE, {
          files: {
            'fxmanifest.lua': MANIFEST,
            'harness.lua': harness,
            'client.lua': client,
            [file.path]: file.source,
          },
        })
        .start()
    })
    return world
  }

  /**
   * Moves the clock of the server, frame by frame, until the harness
   * reports, the server crashes or the clock reaches `timeout`, and returns
   * what the harness reported, if it did. Before each frame, it does what
   * tests asked, then waits for what the server waits for, which so takes
   * no time by its clock.
   */
  async run(timeout: number): Promise<T | undefined> {
    const { clock } = this.engine
    while (this.#report === undefined && this.crash === undefined && clock.now < timeout) {
      for (const action of this.#actions.splice(0)) await action()
      if (this.#pending.length > 0) await Promise.allSettled(this.#pending.splice(0))
      this.#survive(() => this.engine.advance(Math.min(SERVER_FRAME_TIME, timeout - clock.now)))
    }
    return this.#report
  }

  /** Answers what the harness asks with `method`, and the arguments it gave, as msgpack. */
  #answer(method: string | null, args: unknown): Uint8Array {
    switch (method) {
      case 'target':
        return pack(this.#target)
      case 'report':
        this.#report = this.#parse(args)
        return pack(null)
      case 'connect':
        return pack(this.#connect(identityOf(args)))
      case 'connection':
        return pack(this.#state(this.#connections[count(args) - 1]))
      case 'received': {
        const { id, event } = fields(args)
        const { player } = this.#connectionOf(count(id))
        const items = this.#received
          .filter((received) => received.player === player && received.name === text(event))
          .map((received) => unpackObject(received.payload))
        return packObject({ type: 'array', items })
      }
      case 'output': {
        const { id } = fields(args)
        const process = id === undefined ? 'server' : this.#connectionOf(count(id)).process
        const lines = this.output.lines.filter(
          (line) => line.process === process && line.kind === 'console',
        )
        return pack(lines.map(({ channel, text }) => `[${channel}] ${text.replace(/\^\d/g, '')}`))
      }
      case 'disconnect': {
        const { id, reason } = fields(args)
        const { player } = this.#connectionOf(count(id))
        const why = reason === undefined ? undefined : text(reason)
        this.#actions.push(() => this.#survive(() => player!.quit(why)))
        return pack(null)
      }
      default:
        throw new Error(`Unknown method ${String(method)}`)
    }
  }

  /**
   * Asks for a client that connects as a player with `identity`, which
   * the runner starts before the next frame, and returns the number of the
   * connection, from 1.
   */
  #connect(identity: PlayerIdentity): number {
    const connection: Connection = {
      process: `client ${this.#connections.length + 1}`,
      player: undefined,
    }
    this.#connections.push(connection)
    this.#actions.push(async () => {
      const watchdog = this.#options.watchdog ?? WATCHDOG
      const { client, player } = await this.engine.connect(identity, { watchdog })
      connection.player = player
      client.events.onTrigger.connect((name, payload, source) => {
        // The events of the resource that runs the tests are its own.
        if (source.startsWith('net:') && !name.startsWith(`${TEST_RESOURCE}:`)) {
          this.#received.push({ player, name, payload })
        }
      })
    })
    return this.#connections.length
  }

  /** How a connection goes: connecting until its client started, then as its player does. */
  #state(connection: Connection | undefined): PackedValue {
    if (connection === undefined) throw new Error('Unknown connection')
    const { player } = connection
    if (player === undefined) return { state: 'connecting' }
    const { state, netId: id, name, rejection } = player
    return rejection === undefined ? { state, id, name } : { state, id, name, reason: rejection }
  }

  /** The connection whose player has the id `id` on the server. */
  #connectionOf(id: number): Connection {
    const connection = this.#connections.find(({ player }) => player?.netId === id)
    if (connection === undefined) throw new Error(`No player has the id ${id}`)
    return connection
  }

  /** Runs `fn`, and keeps what crashed the server if a runtime crashed. */
  #survive(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      if (!(error instanceof LuaFatalError)) throw error
      this.crash = failure(`the server crashed: ${error.message}`)
    }
  }
}

/** What the processes of a server printed and reported, line by line. */
class Output {
  readonly #lines: OutputLine[] = []
  /** What each process printed on each channel since its last line break. */
  readonly #partial = new Map<string, { process: string; channel: string; text: string }>()

  /** Where the process `process` writes. */
  of(process: string): ProcessOutput {
    return {
      write: (channel, text) => {
        const key = `${process}\n${channel}`
        const pieces = ((this.#partial.get(key)?.text ?? '') + text).split('\n')
        this.#partial.set(key, { process, channel, text: pieces.pop()! })
        for (const piece of pieces) {
          this.#lines.push({ process, kind: 'console', channel, text: piece })
        }
      },
      warn: (resource, message) => {
        this.#lines.push({ process, kind: 'warning', channel: resource, text: message })
      },
      diagnose: (resource, message) => {
        this.#lines.push({ process, kind: 'diagnostic', channel: resource, text: message })
      },
    }
  }

  /** The lines, then what the processes printed after their last line breaks, as lines of their own. */
  get lines(): readonly OutputLine[] {
    const unended = [...this.#partial.values()].filter(({ text }) => text !== '')
    return [
      ...this.#lines,
      ...unended.map(({ process, channel, text }) => ({
        process,
        kind: 'console' as const,
        channel,
        text,
      })),
    ]
  }
}

const decoder = new TextDecoder()

/** A msgpack value as JavaScript has it, with maps as objects by their keys as strings. */
function plain(object: MsgpackObject): unknown {
  switch (object.type) {
    case 'nil':
    case 'ext':
      return undefined
    case 'boolean':
    case 'float32':
    case 'float64':
      return object.value
    case 'positive':
    case 'negative':
      return Number(object.value)
    case 'str':
    case 'bin':
      return decoder.decode(object.bytes)
    case 'array':
      return object.items.map(plain)
    case 'map':
      return Object.fromEntries(object.entries.map(([key, value]) => [plain(key), plain(value)]))
  }
}

function loadedOf(value: unknown): Loaded {
  const loaded = record(value)
  const failure = loaded.failure === undefined ? undefined : failureOf(loaded.failure)
  return { tests: list(loaded.tests).map(collectedOf), failure }
}

function ranOf(value: unknown): Ran {
  const ran = record(value)
  const names = ran.names === undefined ? undefined : list(ran.names).map(text)
  return { names, failures: list(ran.failures).map(failureOf) }
}

function collectedOf(value: unknown): Collected {
  const test = record(value)
  const { mode, timeout } = test
  if (mode !== 'run' && mode !== 'skip' && mode !== 'only') {
    throw new Error(`Unknown mode ${String(mode)}`)
  }
  if (timeout !== undefined && typeof timeout !== 'number') {
    throw new Error('Timeouts are numbers')
  }
  return { names: list(test.names).map(text), mode, timeout }
}

function failureOf(value: unknown): Failure {
  const failure = record(value)
  const frames = list(failure.frames).map((value): Frame => {
    const frame = record(value)
    if (typeof frame.line !== 'number') throw new Error('Frames have lines')
    return frame.name === undefined
      ? { line: frame.line }
      : { line: frame.line, name: text(frame.name) }
  })
  return { message: text(failure.message), frames }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a table')
  }
  return value as Record<string, unknown>
}

/** The fields of a table, which Lua packs as a map, or as an array while it is empty. */
function fields(value: unknown): Readonly<Record<string, unknown>> {
  return Array.isArray(value) && value.length === 0 ? {} : record(value)
}

/** The items of a list, which Lua packs as an array. */
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a list')
  return value
}

/** A whole number, as the harness counts connections and the ids of players. */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error('Expected a whole number')
  return value
}

/** The identity of a player, as the harness gives it. */
function identityOf(value: unknown): PlayerIdentity {
  const { name, guid, endpoint, identifiers, tokens } = fields(value)
  return {
    ...(name === undefined ? {} : { name: text(name) }),
    ...(guid === undefined ? {} : { guid: text(guid) }),
    ...(endpoint === undefined ? {} : { endpoint: text(endpoint) }),
    ...(identifiers === undefined ? {} : { identifiers: list(identifiers).map(text) }),
    ...(tokens === undefined ? {} : { tokens: list(tokens).map(text) }),
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string')
  return value
}
