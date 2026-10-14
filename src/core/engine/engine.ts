import { LuaRuntime } from '../lua/index.ts'
import type { Side } from '../natives/index.ts'
import { Clock } from './clock.ts'
import { ResourceManager, type ProcessOutput, type ResourceManagerOptions } from './manager.ts'
import { Session, type Player, type PlayerIdentity } from './session.ts'

/** How often FiveM's server runs its frames, which tick its resources: 20 times a second. */
export const SERVER_FRAME_TIME = 1000 / 20

/** How often clients run their game frames by default: 60 times a second. */
export const CLIENT_FRAME_TIME = 1000 / 60

/** A process of an engine, as it is created. */
export interface EngineProcess {
  readonly side: Side
  /** "server", or "client 1", "client 2" and on, in the order the clients came. */
  readonly name: string
}

/** What processes take of the options of a resource manager, but what the engine gives them. */
export type EngineProcessOptions = Omit<ResourceManagerOptions, 'side' | 'lua' | 'time' | 'output'>

export interface EngineOptions {
  /** cfxlua.wasm, compiled, which each process runs an instance of. */
  readonly cfxlua: WebAssembly.Module
  /** Where each process writes what it reports, which it is given as it is created. Nowhere by default. */
  readonly output?: (process: EngineProcess) => ProcessOutput
  /** The options of the server. */
  readonly server?: EngineProcessOptions
  /** Milliseconds between the game frames of clients. */
  readonly clientFrameTime?: number
}

/** Writes nothing. */
const SILENT: ProcessOutput = { write: () => {}, warn: () => {}, diagnose: () => {} }

/**
 * A FiveM server, the clients that connect to it, and the clock they run
 * on, which moves only when the engine is told to advance: the server runs
 * a frame every 50 milliseconds, as FiveM's does, and the clients their
 * game frames, each with a time of its own since the engine started it.
 */
export class Engine {
  readonly clock: Clock
  readonly server: ResourceManager
  readonly session: Session
  readonly #options: EngineOptions
  readonly #clients: ResourceManager[] = []

  private constructor(options: EngineOptions, clock: Clock, server: ResourceManager) {
    this.#options = options
    this.clock = clock
    this.server = server
    this.session = new Session(server)
    clock.every(SERVER_FRAME_TIME, () => server.tick())
  }

  /** Starts an engine with a server, at the time 0 of its clock. */
  static async create(options: EngineOptions): Promise<Engine> {
    const clock = new Clock()
    const server = await createProcess(options, clock, 'server', 'server', options.server)
    return new Engine(options, clock, server)
  }

  /** The clients that the engine started, in the order they came. */
  get clients(): readonly ResourceManager[] {
    return this.#clients
  }

  /**
   * Starts a client and connects it to the server with `identity`, as the
   * player that it then is. It joins as the clock moves on.
   */
  async connect(
    identity: PlayerIdentity = {},
    options: EngineProcessOptions = {},
  ): Promise<{ readonly client: ResourceManager; readonly player: Player }> {
    const name = `client ${this.#clients.length + 1}`
    const client = await createProcess(this.#options, this.clock, 'client', name, options)
    this.#clients.push(client)
    this.clock.every(this.#options.clientFrameTime ?? CLIENT_FRAME_TIME, () => client.tick())
    return { client, player: this.session.connect(client, identity) }
  }

  /** Moves the clock forward by `ms`, through the frames of the processes that are due. */
  advance(ms: number): void {
    this.clock.advance(ms)
  }
}

/** A process on `clock`, whose time starts as it does, with its own instance of cfxlua.wasm. */
async function createProcess(
  options: EngineOptions,
  clock: Clock,
  side: Side,
  name: string,
  processOptions: EngineProcessOptions = {},
): Promise<ResourceManager> {
  const start = clock.now
  const lua = await LuaRuntime.create(options.cfxlua, { output: () => {} })
  return new ResourceManager({
    ...processOptions,
    side,
    lua,
    time: () => clock.now - start,
    output: options.output?.({ side, name }) ?? SILENT,
  })
}
