import type { LuaRuntime } from '../lua/index.ts'
import {
  catalogNatives,
  NativeRegistry,
  nativeWrapper,
  type NativeDefinition,
  type Side,
} from '../natives/index.ts'
import { CLOCK_START } from '../scripting/runtime.ts'
import type { NativeContext } from './context.ts'
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
  /**
   * The resources whose runtimes are running, the innermost call last, as
   * FiveM keeps its runtime stack.
   */
  readonly runtimeStack: Resource[] = []
  readonly #time: () => number
  readonly #resources = new Map<string, Resource>()
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
    this.#resources.set(name, resource)
    return resource
  }

  getResource(name: string): Resource | undefined {
    return this.#resources.get(name)
  }

  get resources(): IterableIterator<Resource> {
    return this.#resources.values()
  }

  /**
   * Resumes the threads that are due in all runtimes. Like FiveM, it takes
   * the due threads of every runtime before it resumes any, so that threads
   * queued during the tick wait for the next one.
   */
  tick(): void {
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

  /** The Lua code that defines the native called `name`, for Citizen.LoadNative. */
  nativeWrapper(name: string): string | null {
    const native = this.natives.byName(name)
    return native === undefined
      ? null
      : nativeWrapper(native, name, { direct: this.side === 'client' })
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
