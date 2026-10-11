import { ScriptRuntime, type ScriptHost } from '../scripting/runtime.ts'
import { NativeContext } from './context.ts'
import type { ResourceManager } from './manager.ts'

/** The states of a resource, named as GetResourceState names them. */
export type ResourceState = 'uninitialized' | 'stopped' | 'starting' | 'started' | 'stopping'

/** What a resource is made of. */
export interface ResourceDefinition {
  /** The files of the resource by path, such as client.lua. */
  readonly files: Readonly<Record<string, string | Uint8Array>>
  /** The entries of its manifest in order, such as ['client_script', 'client.lua']. */
  readonly metadata: readonly (readonly [key: string, value: string])[]
}

/**
 * A resource of one process. Starting it creates a Lua runtime for its
 * scripts on the process's side, if it has any, and runs them, the way
 * FiveM's scripting component does.
 */
export class Resource {
  readonly name: string
  readonly manager: ResourceManager
  readonly metadata: readonly (readonly [key: string, value: string])[]
  readonly #files: ReadonlyMap<string, string | Uint8Array>
  #state: ResourceState = 'stopped'
  #runtime: ScriptRuntime | null = null
  #context: NativeContext | null = null
  /** How many calls into each runtime of the resource are running. */
  readonly #depth = new Map<ScriptRuntime, number>()
  /** Runtimes of a stopped resource that close when their last call returns. */
  readonly #retired = new Set<ScriptRuntime>()

  constructor(manager: ResourceManager, name: string, definition: ResourceDefinition) {
    this.manager = manager
    this.name = name
    this.metadata = definition.metadata
    this.#files = new Map(Object.entries(definition.files))
  }

  get state(): ResourceState {
    return this.#state
  }

  /** The Lua runtime of the started resource, or null if it has none. */
  get runtime(): ScriptRuntime | null {
    return this.#runtime
  }

  /** The values of the manifest entries with `key`, in order. */
  entries(key: string): string[] {
    return this.metadata.filter(([name]) => name === key).map(([, value]) => value)
  }

  /** The scripts the resource runs on its process's side: its shared scripts, then its client or server scripts. */
  get scripts(): string[] {
    return [...this.entries('shared_script'), ...this.entries(`${this.manager.side}_script`)]
  }

  file(path: string): string | Uint8Array | undefined {
    return this.#files.get(path)
  }

  /** Starts the resource. Returns whether it started; one that is started already counts. */
  start(): boolean {
    if (this.#state === 'started') return true
    this.#state = 'starting'
    this.#createRuntime()
    this.#state = 'started'
    return true
  }

  /** Stops the resource, closing its runtime once no call into it is running. */
  stop(): boolean {
    if (this.#state === 'stopped') return true
    this.#destroyRuntime()
    this.#state = 'stopped'
    return true
  }

  /**
   * Runs `fn` as a call into the resource's runtime, which FiveM marks by
   * pushing the runtime onto the process's runtime stack: GetCurrentResourceName
   * names the resource on top, and GetInvokingResource the one below it.
   */
  enter<T>(fn: () => T): T {
    const runtime = this.#runtime
    const stack = this.manager.runtimeStack
    stack.push(this)
    if (runtime !== null) this.#depth.set(runtime, (this.#depth.get(runtime) ?? 0) + 1)
    try {
      return fn()
    } finally {
      stack.pop()
      if (runtime !== null) {
        const depth = this.#depth.get(runtime)! - 1
        if (depth > 0) {
          this.#depth.set(runtime, depth)
        } else {
          this.#depth.delete(runtime)
          if (this.#retired.delete(runtime)) runtime.close()
        }
      }
    }
  }

  /**
   * Creates the runtime and loads the scripts into it, as FiveM does for a
   * resource with scripts that its Lua runtime handles: those with ".lua" in
   * their name.
   */
  #createRuntime(): void {
    const scripts = this.scripts
    for (const path of scripts) {
      if (!path.includes('.lua')) {
        this.manager.output.diagnose(
          this.name,
          `FiveLab runs only Lua scripts, so it skips ${path}.`,
        )
      }
    }
    const lua = scripts.filter((path) => path.includes('.lua'))
    if (lua.length === 0) return
    this.manager.log('citizen-scripting-core', `Creating script environments for ${this.name}\n`)
    const runtime = this.enter(() => ScriptRuntime.create(this.manager.lua, this.#host()))
    this.#runtime = runtime
    this.manager.addRuntime(this)
    for (const path of lua) {
      // A script that stopped the resource took the runtime the rest would load into.
      if (this.#runtime !== runtime) break
      const source = this.#files.get(path)
      const loaded = source !== undefined && this.enter(() => runtime.runFile(path, source))
      if (!loaded) this.manager.log('citizen-scripting-core', `Failed to load script ${path}.\n`)
    }
  }

  #destroyRuntime(): void {
    const runtime = this.#runtime
    if (runtime === null) return
    this.#runtime = null
    this.#context = null
    this.manager.removeRuntime(this)
    if (this.#depth.has(runtime)) this.#retired.add(runtime)
    else runtime.close()
  }

  #host(): ScriptHost {
    const { manager, name } = this
    return {
      resource: name,
      natives: {
        client: manager.side === 'client',
        load: (native) => manager.nativeWrapper(native),
        invoke: (runtime, ptr) => manager.natives.invoke(this.#contextFor(runtime), ptr),
      },
      clock: () => manager.clock(),
      trace: (text) => manager.log(`script:${name}`, text),
      warn: (message) => manager.output.warn(name, message),
      log: (channel, text) => manager.log(channel, text),
      diagnose: (message) => manager.output.diagnose(name, message),
    }
  }

  #contextFor(runtime: ScriptRuntime): NativeContext {
    if (this.#context?.runtime !== runtime) this.#context = new NativeContext(runtime, this)
    return this.#context
  }
}
