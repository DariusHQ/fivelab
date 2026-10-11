import type { LuaRuntime } from '../lua/index.ts'
import {
  catalogNatives,
  NativeRegistry,
  nativeWrapper,
  type NativeDefinition,
  type Side,
} from '../natives/index.ts'
import { CLOCK_START } from '../scripting/runtime.ts'
import { Constraints, DEFAULT_GAME_BUILD, FIVEM_BUILD, parseGameBuild } from './constraints.ts'
import type { NativeContext } from './context.ts'
import { Dependencies } from './dependencies.ts'
import { EventManager } from './events.ts'
import { INT32_MIN } from './hook.ts'
import { isFxVersionAtLeast } from './manifest.ts'
import { engineNatives } from './natives/index.ts'
import { Resource, type ResourceDefinition } from './resource.ts'

/** Where a process writes what it reports. */
export interface ProcessOutput {
  /**
   * Writes to the process's console on a channel: script:<resource> for what
   * a resource prints, or the name of a FiveM component, such as
   * citizen-scripting-core. The text need not end at a line break.
   */
  write(channel: string, text: string): void
  /** Reports a Lua warning of a resource: what warn() reports and errors in finalizers. */
  warn(resource: string, message: string): void
  /** Reports a mistake in how a resource uses FiveM that FiveLab noticed. */
  diagnose(resource: string, message: string): void
}

export interface ResourceManagerOptions {
  /** Whether the process is the server or a client. */
  readonly side: Side
  /** The instance of cfxlua.wasm that hosts the process's script runtimes. */
  readonly lua: LuaRuntime
  /** Milliseconds since the process started. It must not go back. */
  readonly time: () => number
  readonly output: ProcessOutput
  /** Natives on top of FiveLab's, which replace those with their hash or name. */
  readonly natives?: readonly NativeDefinition<NativeContext>[]
  /** On servers, whether OneSync is on, as it is by default in FiveM. */
  readonly oneSync?: boolean
  /** On servers, the game build that sv_enforceGameBuild enforces, 3258 by default as in FiveM. */
  readonly gameBuild?: number
}

/**
 * The resources of one FiveM process, the server or a client, and the
 * natives their scripts call.
 */
export class ResourceManager {
  readonly side: Side
  readonly lua: LuaRuntime
  readonly output: ProcessOutput
  readonly natives = new NativeRegistry<NativeContext>()
  readonly events = new EventManager(this)
  /** What dependencies such as /server:5181 test, which only servers enforce. */
  readonly constraints = new Constraints()
  readonly #dependencies = new Dependencies(this)
  /**
   * The resources whose runtimes are running, the innermost call last, as
   * FiveM keeps its runtime stack.
   */
  readonly runtimeStack: Resource[] = []
  readonly #time: () => number
  readonly #resources = new Map<string, Resource>()
  /** The resources that provide each name, as their provide entries say, in the order they were added. */
  readonly #provides = new Map<string, Resource[]>()
  /**
   * Resources with a runtime, in the order their runtimes were created: the
   * order FiveM resumes their threads in.
   */
  readonly #ticking: Resource[] = []

  constructor(options: ResourceManagerOptions) {
    this.side = options.side
    this.lua = options.lua
    this.output = options.output
    this.#time = options.time
    this.natives.register(
      ...catalogNatives<NativeContext>(this.side),
      ...engineNatives(this.side),
      ...(options.natives ?? []),
    )
    if (this.side === 'server') {
      this.#registerConstraints(options.oneSync ?? true, options.gameBuild ?? DEFAULT_GAME_BUILD)
    }
  }

  /** Milliseconds since the process started. */
  time(): number {
    return this.#time()
  }

  /** The clock that threads wait by, in whole microseconds; see CLOCK_START. */
  clock(): number {
    return CLOCK_START + Math.floor(this.#time() * 1000)
  }

  /** The resource whose script code is running, which GetCurrentResourceName names. */
  get currentResource(): Resource | undefined {
    return this.runtimeStack.at(-1)
  }

  /** The resource whose script code called into the current one, which GetInvokingResource names. */
  get invokingResource(): Resource | undefined {
    return this.runtimeStack.at(-2)
  }

  /** Adds a stopped resource. */
  addResource(name: string, definition: ResourceDefinition): Resource {
    if (this.#resources.has(name)) throw new Error(`There is a resource named ${name} already`)
    const resource = new Resource(this, name, definition)
    this.#dependencies.attach(resource)
    if (this.side === 'server') {
      // FiveM's server checks manifests before anything else of a start, and
      // reports the resources it starts and stops.
      resource.onStart.connect(() => this.#checkManifest(resource), INT32_MIN)
      resource.onStart.connect(() => this.#reportStart(resource), 99_999_999)
      resource.onStop.connect(() => this.log('resources', `Stopping resource ${name}\n`), -1000)
    }
    this.#resources.set(name, resource)
    for (const provided of resource.entries('provide')) {
      const providers = this.#provides.get(provided)
      if (providers === undefined) this.#provides.set(provided, [resource])
      else providers.push(resource)
    }
    return resource
  }

  /**
   * The resource named `name`, as FiveM finds resources. Unless told not
   * to, it takes a resource that provides the name instead: when there is
   * none of the name, the first, and when it is stopped, the first that
   * started.
   */
  getResource(name: string, withProvides = true): Resource | undefined {
    const resource = this.#resources.get(name)
    if (!withProvides || (resource !== undefined && resource.state !== 'stopped')) return resource
    for (const provider of this.#provides.get(name) ?? []) {
      if (provider.state === 'started' || resource === undefined) return provider
    }
    return resource
  }

  get resources(): IterableIterator<Resource> {
    return this.#resources.values()
  }

  /**
   * Runs a tick as FiveM does: it triggers the queued events, then resumes
   * the threads that are due in all runtimes. It takes the due threads of
   * every runtime before it resumes any, so that threads queued during the
   * tick wait for the next one.
   */
  tick(): void {
    this.events.tick()
    const ticking = this.#ticking.map((resource) => ({ resource, runtime: resource.runtime! }))
    for (const { runtime } of ticking) runtime.collect()
    for (const { resource, runtime } of ticking) {
      // A runtime closed by a thread that ran before it has nothing to resume.
      if (resource.runtime === runtime) resource.enter(() => runtime.resume())
    }
  }

  /** Writes to the console on `channel`; see ProcessOutput.write. */
  log(channel: string, text: string): void {
    this.output.write(channel, text)
  }

  /** Writes a warning to the console on `channel`, as FiveM's console::PrintWarning does. */
  logWarning(channel: string, text: string): void {
    this.log(channel, colored('^3Warning: ', text))
  }

  /** Writes an error to the console on `channel`, as FiveM's console::PrintError does. */
  logError(channel: string, text: string): void {
    this.log(channel, colored('^1Error: ', text))
  }

  /** The Lua code that defines the native called `name`, for Citizen.LoadNative. */
  nativeWrapper(name: string): string | null {
    const native = this.natives.byName(name)
    return native === undefined
      ? null
      : nativeWrapper(native, name, { direct: this.side === 'client' })
  }

  /**
   * Enforces the constraints of FiveM's server: its build, OneSync, the game
   * build that it enforces, and the natives that it has.
   */
  #registerConstraints(oneSync: boolean, gameBuild: number): void {
    this.constraints.enforcing = true
    this.constraints.register('server', FIVEM_BUILD)
    this.constraints.register('onesync', () => oneSync || 'OneSync needs to be enabled')
    this.constraints.register('gameBuild', (value) => {
      const build = parseGameBuild(value)
      if (gameBuild === 0 || build === undefined) return false
      if (gameBuild >= build) return true
      return `sv_enforceGameBuild needs to be at least ${build} (current is ${gameBuild})`
    })
    this.constraints.register('native', (value) => {
      if (value.length <= 2 || !value.startsWith('0x')) return false
      const hash = strtoull(value.slice(2))
      if (this.natives.byHash(hash) !== undefined) return true
      return `native 0x${hash.toString(16).toUpperCase()} isn't supported`
    })
  }

  /**
   * Whether FiveM's server lets a resource start, by what its fxmanifest.lua
   * says of the game and its version, which must be GTA V's, or common, and
   * adamant or later. Resources with a __resource.lua may start on GTA V's.
   */
  #checkManifest(resource: Resource): boolean {
    if (resource.entries('is_cfxv2').length === 0) return true
    const name = resource.name
    const games = resource.entries('game')
    const common = games.includes('common')
    const gta5 = games.includes('gta5')
    let allowed = true
    if (common && gta5) {
      this.logWarning(
        'resources',
        `Resource ${name} specifies both \`common\` and a specific game. This is considered ill-formed.\n`,
      )
      allowed = false
    } else if (!common && !gta5) {
      this.logWarning('resources', `Resource ${name} does not support the current game (gta5).\n`)
      allowed = false
    }
    if (!isFxVersionAtLeast(resource.metadata, 'adamant')) {
      this.logWarning(
        'resources',
        `Resource ${name} does not specify an \`fx_version\` in fxmanifest.lua.\n`,
      )
      allowed = false
    }
    return allowed
  }

  /**
   * Reports a resource that started as FiveM's server does, warning about
   * the files its manifest names that it does not have.
   */
  #reportStart(resource: Resource): void {
    let warnings = 0
    for (const key of ['client_script', 'server_script', 'shared_script', 'file']) {
      for (const { value, location, found } of resource.missingEntries(key)) {
        // Patterns that only matched nothing go unreported.
        if (found) continue
        const file = location?.file ?? ''
        const where = `${file.slice(file.lastIndexOf('/') + 1)}:${location?.line ?? 0}`
        this.logWarning(
          `resources:${resource.name}`,
          `could not find ${key} \`${value}\` (defined in ${where})\n`,
        )
        warnings++
      }
    }
    const counted = warnings === 0 ? '' : ` (${warnings} warning${warnings === 1 ? '' : 's'})`
    this.log('resources', `Started resource ${resource.name}${counted}\n`)
  }

  /** @internal Called by a resource that created its runtime. */
  addRuntime(resource: Resource): void {
    this.#ticking.push(resource)
  }

  /** @internal Called by a resource that destroys its runtime. */
  removeRuntime(resource: Resource): void {
    this.#ticking.splice(this.#ticking.indexOf(resource), 1)
  }
}

/**
 * C's strtoull in base 16: the hexadecimal number at the start of `text`,
 * after an optional sign and 0x, or 0. Numbers that do not fit in 64 bits
 * give the largest that does, and a minus sign negates the result.
 */
function strtoull(text: string): bigint {
  const parts = /^[\t-\r ]*([+-]?)(?:0[xX](?=[\da-fA-F]))?([\da-fA-F]*)/.exec(text)!
  if (parts[2] === '') return 0n
  const value = BigInt(`0x${parts[2]}`)
  if (value > MAX_UINT64) return MAX_UINT64
  return parts[1] === '-' ? BigInt.asUintN(64, -value) : value
}

const MAX_UINT64 = 2n ** 64n - 1n

/** Puts `prefix` before `text`, and ends its color before the line breaks at its end, as FiveM does. */
function colored(prefix: string, text: string): string {
  const message = prefix + text
  const end = message.replace(/\n+$/, '').length
  return `${message.slice(0, end)}^7${message.slice(end)}`
}
