import { LuaError, type LuaRuntime } from '../lua/index.ts'
import {
  catalogNatives,
  NativeRegistry,
  nativeWrapper,
  type NativeDefinition,
  type Side,
} from '../natives/index.ts'
import { CLOCK_START, type ScriptRuntime, type StackBoundaries } from '../scripting/runtime.ts'
import { Constraints, DEFAULT_GAME_BUILD, FIVEM_BUILD, parseGameBuild } from './constraints.ts'
import type { NativeContext } from './context.ts'
import { Dependencies } from './dependencies.ts'
import { EventManager } from './events.ts'
import { INT32_MIN } from './hook.ts'
import { atoi, strtoull } from '../libc.ts'
import { isFxVersionAtLeast } from './manifest.ts'
import { arrayLength } from './msgpack.ts'
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

/** What a function reference names; see ResourceManager.lookUpRef. */
export interface FoundRef {
  readonly resource: Resource
  readonly runtime: ScriptRuntime
  /** The index of the reference in the runtime. */
  readonly index: number
}

/**
 * A call into a resource's runtime, as FiveM's script host keeps them on its
 * runtime stack, with the boundaries that stack traces walk between.
 */
interface RuntimeCall {
  readonly resource: Resource
  /** The runtime the call entered, or null if the resource had none. */
  readonly runtime: ScriptRuntime | null
  start: bigint | null
  end: bigint | null
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
  /** The calls into runtimes that are running, the innermost last. */
  readonly #calls: RuntimeCall[] = []
  /**
   * Whether a stack trace was formatted since the outermost call into a
   * runtime began, as FiveM's g_suppressErrors says; see formatStackTrace.
   */
  #suppressErrors = false
  readonly #time: () => number
  readonly #resources = new Map<string, Resource>()
  /** The resources that provide each name, as their provide entries say, in the order they were added. */
  readonly #provides = new Map<string, Resource[]>()
  /**
   * Resources with a runtime, in the order their runtimes were created: the
   * order FiveM resumes their threads in.
   */
  readonly #ticking: Resource[] = []
  /** The state of the rand() that ids of runtimes come from, which starts at 1 on Windows. */
  #rand = 1

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
    return this.#calls.at(-1)?.resource
  }

  /** The resource whose script code called into the current one, which GetInvokingResource names. */
  get invokingResource(): Resource | undefined {
    return this.#calls.at(-2)?.resource
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
   * The runtime that a function reference names, and the index of the
   * reference in it, as FiveM looks references up: by the resource, or one
   * that provides its name, and the id of the runtime it runs.
   */
  lookUpRef(ref: string): FoundRef | undefined {
    const { resource: name, instance, index } = parseRef(ref)
    // FiveM's own runtime for callbacks of its C++ code, which FiveLab has not.
    if (name === '_cfx_internal') return undefined
    const resource = this.getResource(name)
    const runtime = resource?.runtime
    if (resource === undefined || runtime == null || runtime.host.instanceId !== instance) {
      return undefined
    }
    return { resource, runtime, index }
  }

  /**
   * Calls the function that a function reference names, as FiveM's script
   * host does: in the runtime that lookUpRef finds, with arguments that
   * msgpack packed. Returns the results packed, null if the runtime failed
   * to call the function, or undefined if no runtime has the reference.
   */
  invokeFunctionReference(ref: string, args: Uint8Array): Uint8Array | null | undefined {
    const found = this.lookUpRef(ref)
    if (found === undefined) return undefined
    const { resource, runtime, index } = found
    return resource.enter(() => runtime.callRef(index, args))
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

  /**
   * The stack trace of the runtimes that are running, as FiveM's
   * FORMAT_STACK_TRACE formats it: the frames each call into a runtime walks
   * between its boundaries, the innermost call first. Scripts may give
   * frames of their own to put first, which FiveLab does not read; once a
   * stack trace was formatted, such calls get null until the outermost call
   * into a runtime returns, as in FiveM.
   */
  formatStackTrace(frames: Uint8Array | null): string | null {
    if (frames !== null && this.#suppressErrors) return null
    this.#suppressErrors = true
    const current = this.#calls.at(-1)
    if (frames !== null && arrayLength(frames) > 0 && current !== undefined) {
      this.output.diagnose(
        current.resource.name,
        'FormatStackTrace was given stack frames to put first, which FiveLab does not read yet: it leaves them out of the stack trace.',
      )
    }
    let trace = ''
    for (let i = this.#calls.length - 1; i >= 0; i--) {
      const { runtime, start, end } = this.#calls[i]!
      if (runtime === null) continue
      try {
        for (const { name, file, line } of runtime.walkStack({ start, end })) {
          trace += `^3> ${name}^7 (^5${file}^7:${line})\n`
        }
      } catch (error) {
        if (!(error instanceof LuaError)) throw error
        // FiveM reports it on the console of the current runtime.
        this.log(
          `script:${current!.resource.name}`,
          runtime.describeRoutineError('stack trace', error),
        )
      }
    }
    return trace
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

  /**
   * @internal An id for a new runtime. FiveM draws them from C's rand(),
   * which FiveLab emulates as Windows has it, from the first number it gives.
   */
  instanceId(): number {
    this.#rand = (Math.imul(this.#rand, 214_013) + 2_531_011) >>> 0
    return (this.#rand >>> 16) & 0x7fff
  }

  /** @internal Called by a resource when a call enters its runtime, or the resource if it has none. */
  pushCall(resource: Resource, runtime: ScriptRuntime | null): void {
    this.#calls.push({ resource, runtime, start: null, end: null })
  }

  /** @internal Called by a resource when the innermost call into its runtime returns. */
  popCall(): void {
    this.#calls.pop()
    if (this.#calls.length === 0) this.#suppressErrors = false
  }

  /** @internal Sets a boundary of the innermost call; see ScriptHost.submitBoundary. */
  submitBoundary(which: keyof StackBoundaries, id: bigint | null): void {
    const call = this.#calls.at(-1)
    if (call !== undefined) call[which] = id
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
 * The parts of a function reference, "resource:instance:index", as FiveM
 * reads them: the resource is what comes before the first colon, the
 * instance what follows it and the index what follows the second, which
 * atoi reads. Without a second colon, the index is read from the start.
 */
function parseRef(ref: string): { resource: string; instance: number; index: number } {
  const first = ref.indexOf(':')
  const second = ref.indexOf(':', first + 1)
  // FiveM takes `second - first` characters after the first colon, all of the
  // rest when that is negative.
  const length = second - first
  return {
    resource: first === -1 ? ref : ref.slice(0, first),
    instance: atoi(length < 0 ? ref.slice(first + 1) : ref.slice(first + 1, first + 1 + length)),
    index: atoi(ref.slice(second + 1)),
  }
}

/** Puts `prefix` before `text`, and ends its color before the line breaks at its end, as FiveM does. */
function colored(prefix: string, text: string): string {
  const message = prefix + text
  const end = message.replace(/\n+$/, '').length
  return `${message.slice(0, end)}^7${message.slice(end)}`
}
