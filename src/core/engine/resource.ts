import { ScriptRuntime, type ScriptHost } from '../scripting/runtime.ts'
import { NativeContext } from './context.ts'
import { FileTree, glob } from './glob.ts'
import { Hook } from './hook.ts'
import type { ResourceManager } from './manager.ts'
import { readManifest, type MetadataEntry, type MetadataLocation } from './manifest.ts'

/** The states of a resource, named as GetResourceState names them. */
export type ResourceState = 'uninitialized' | 'stopped' | 'starting' | 'started' | 'stopping'

/** What a resource is made of. */
export interface ResourceDefinition {
  /** The files of the resource by path, such as client.lua. */
  readonly files: Readonly<Record<string, string | Uint8Array>>
  /**
   * The entries of its manifest in order, such as ['client_script', 'client.lua'].
   * Without them, the resource reads its fxmanifest.lua or __resource.lua.
   */
  readonly metadata?: readonly MetadataEntry[]
  /** Where the resource is, as FiveM's messages name it. Defaults to resources/<name>. */
  readonly path?: string
}

/** A manifest entry that names no files. */
export interface MissingEntry {
  readonly value: string
  readonly location: MetadataLocation | undefined
  /** Whether every part the value spells out exists, so that only its pattern matched nothing. */
  readonly found: boolean
}

/**
 * A resource of one process. Starting it creates a Lua runtime for its
 * scripts on the process's side, if it has any, and runs them, the way
 * FiveM's scripting component does.
 */
export class Resource {
  readonly name: string
  readonly manager: ResourceManager
  readonly path: string
  readonly metadata: readonly MetadataEntry[]
  /**
   * The events the resource's scripts registered handlers for. FiveM keeps
   * them for as long as the resource exists, across restarts.
   */
  readonly handledEvents = new Set<string>()
  /** Runs when the resource starts. A callback that returns false keeps it from starting. */
  readonly onBeforeStart = new Hook()
  /** Runs when the resource is starting, after onBeforeStart. A callback that returns false fails the start. */
  readonly onStart = new Hook()
  /** Runs when the resource stops. */
  readonly onStop = new Hook()
  readonly #files: ReadonlyMap<string, string | Uint8Array>
  #tree: FileTree | undefined
  #state: ResourceState = 'stopped'
  #runtime: ScriptRuntime | null = null
  #context: NativeContext | null = null
  /** How many calls into each runtime of the resource are running. */
  readonly #depth = new Map<ScriptRuntime, number>()
  /** Runtimes of a stopped resource that close when their last call returns. */
  readonly #retired = new Set<ScriptRuntime>()

  /** Throws a ManifestError when the resource has no metadata and its manifest does not load. */
  constructor(manager: ResourceManager, name: string, definition: ResourceDefinition) {
    this.manager = manager
    this.name = name
    this.path = definition.path ?? `resources/${name}`
    this.#files = new Map(Object.entries(definition.files))
    this.metadata =
      definition.metadata ?? readManifest(manager.lua, this.path, (path) => this.#files.get(path))
    // FiveM's event component connects to a resource's hooks before its scripting component does.
    manager.events.attach(this)
    this.onStart.connect(() => this.#createRuntime())
    this.onStop.connect(() => this.#destroyRuntime())
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

  /** The files that the manifest entries with `key` name, as FiveM globs them: those of each entry in turn. */
  globEntries(key: string): string[] {
    const tree = this.#fileTree()
    return this.entries(key).flatMap((value) => glob(tree, value).files)
  }

  /**
   * The manifest entries with `key` that name no files, with where they were
   * defined and whether every part they spell out exists, as FiveM's server
   * looks for them to warn about them.
   */
  missingEntries(key: string): MissingEntry[] {
    const tree = this.#fileTree()
    return this.metadata
      .filter(([name]) => name === key)
      .flatMap(([, value, location]) => {
        const { files, found } = glob(tree, value)
        return files.length === 0 ? [{ value, location, found }] : []
      })
  }

  /** The scripts the resource runs on its process's side: its shared scripts, then its client or server scripts. */
  get scripts(): string[] {
    return [
      ...this.globEntries('shared_script'),
      ...this.globEntries(`${this.manager.side}_script`),
    ]
  }

  file(path: string): string | Uint8Array | undefined {
    return this.#files.get(path)
  }

  /**
   * Starts the resource as FiveM does, and returns whether it started; one
   * that is started already counts. The resource is starting while its hooks
   * run, and stopped again if one of them returns false, unless it got
   * started meanwhile.
   */
  start(): boolean {
    if (this.#state !== 'started') {
      // A resource started while it starts skips onBeforeStart, as in FiveM.
      if (this.#state !== 'starting') {
        this.#state = 'starting'
        if (!this.onBeforeStart.run()) return this.#failStart()
      }
      if (!this.onStart.run()) return this.#failStart()
    }
    this.#state = 'started'
    return true
  }

  /** Stops the resource as FiveM does. Its runtime closes once no call into it is running. */
  stop(): boolean {
    if (this.#state !== 'stopped') {
      if (!this.onStop.run()) return false
      this.#state = 'stopped'
    }
    return true
  }

  /**
   * Gives the resource an event, as FiveM's scripting component does: if its
   * scripts handle the event, or "*", and it has a runtime to run them in.
   */
  handleEvent(name: string, payload: Uint8Array, source: string): void {
    const runtime = this.#runtime
    if (runtime === null || !(this.handledEvents.has(name) || this.handledEvents.has('*'))) return
    this.enter(() => runtime.triggerEvent(name, payload, source))
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

  #fileTree(): FileTree {
    this.#tree ??= new FileTree(this.path, this.#files.keys())
    return this.#tree
  }

  /** Ends a start that a hook failed, as FiveM does. */
  #failStart(): false {
    if (this.#state !== 'started') this.#state = 'stopped'
    return false
  }

  /**
   * Creates the runtime and loads the scripts into it, as FiveM does for a
   * resource with scripts that its Lua runtime handles: those with ".lua" in
   * their name.
   */
  #createRuntime(): void {
    if (this.#runtime !== null) {
      this.manager.output.diagnose(
        this.name,
        `${this.name} was started while it started. FiveM would then create another runtime for it and load its scripts again in both runtimes, which FiveLab does not emulate: it keeps the runtime it has.`,
      )
      return
    }
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
