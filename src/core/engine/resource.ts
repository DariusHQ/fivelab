import { Hook } from '../hook.ts'
import { ScriptRuntime, type ScriptHost } from '../scripting/runtime.ts'
import { NativeContext } from './context.ts'
import { addFile, MemoryFileSystem, type FileSystem } from './files.ts'
import { glob, normalizePath } from './glob.ts'
import type { ResourceManager } from './manager.ts'
import {
  clientNativesFile,
  ManifestError,
  pluralEntries,
  readManifest,
  sameEntries,
  type MetadataEntry,
  type MetadataLocation,
} from './manifest.ts'
import { ioFiles, osFiles } from './vfs.ts'

/** The states of a resource, named as GetResourceState names them. */
export type ResourceState = 'uninitialized' | 'stopped' | 'starting' | 'started' | 'stopping'

/** What a resource is made of. */
export interface ResourceDefinition {
  /**
   * Files to give the resource, by their paths in it, such as client.lua,
   * which FiveRunner adds to the files of the process in the directory of the
   * resource; on clients, only those that FiveM's server sends them. Without
   * them, the resource has the files that are there.
   */
  readonly files?: Readonly<Record<string, string | Uint8Array>>
  /**
   * The entries of its manifest in order, such as ['client_script', 'client.lua'].
   * Without them, the resource reads its fxmanifest.lua or __resource.lua.
   */
  readonly metadata?: readonly MetadataEntry[]
  /**
   * Where the resource is, as FiveM's messages name it, and on servers, the
   * directories that give its categories. Defaults to resources/<name> on
   * servers, and on clients to resources:/<name>/, where FiveM mounts what
   * servers send.
   */
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
  /**
   * The categories of the resource on servers: the directories in brackets
   * that it is in, such as [local] and [maps] for resources/[local]/[maps]/x,
   * which FiveM's server finds above the directories of resources as it
   * scans them.
   */
  readonly categories: readonly string[]
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
  /** The path of the resource's directory in the files of the process, normalized. */
  readonly #root: string
  #metadata: readonly MetadataEntry[]
  #state: ResourceState = 'stopped'
  #runtime: ScriptRuntime | null = null
  #context: NativeContext | null = null
  /** How many calls into each runtime of the resource are running. */
  readonly #depth = new Map<ScriptRuntime, number>()
  /** Runtimes of a stopped resource that close when their last call returns. */
  readonly #retired = new Set<ScriptRuntime>()
  /** On servers, what clients get of the resource since it last started; see packedForClients. */
  #packed: ResourceDefinition | undefined

  /**
   * Throws a ManifestError when the resource has no metadata and its
   * manifest does not load. Says which entries of its manifest have plural
   * names, which FiveM does not read.
   */
  constructor(manager: ResourceManager, name: string, definition: ResourceDefinition) {
    this.manager = manager
    this.name = name
    this.path =
      definition.path ?? (manager.side === 'client' ? `resources:/${name}/` : `resources/${name}`)
    this.#root = normalizePath(this.path)
    this.categories = categoriesOf(this.path)
    // The resource reads the manifest of the files it is given before it adds them.
    const given = definition.files === undefined ? undefined : this.#filesOf(definition.files)
    const source = given ?? manager.files
    this.#metadata =
      definition.metadata ??
      readManifest(manager.lua, this.path, (path) => source.read(`${this.#root}/${path}`))
    this.#diagnosePlurals()
    if (given !== undefined) this.#addFiles(given)
    // FiveM's event component connects to a resource's hooks before its scripting component does.
    manager.events.attach(this)
    this.onStart.connect(() => this.#createRuntime())
    this.onStop.connect(() => this.#destroyRuntime())
    // FiveM's server packs what clients get once the scripts of the resource loaded.
    if (manager.side === 'server') this.onStart.connect(() => this.#packForClients(), 500)
    // FiveM's server gives each resource that runs an endpoint of its HTTP server.
    manager.httpServer?.attach(this)
  }

  get state(): ResourceState {
    return this.#state
  }

  /** The entries of the resource's manifest, in order. */
  get metadata(): readonly MetadataEntry[] {
    return this.#metadata
  }

  /**
   * On servers, what clients get of the resource, as FiveM's server packs
   * it in its resource.rpf as the resource starts: the files that clients
   * get, as they were then, and for a resource without a manifest, the
   * entries it had. Nothing until the resource first started.
   */
  get packedForClients(): ResourceDefinition | undefined {
    return this.#packed
  }

  /**
   * Reads the manifest of the resource again, from the directory at `path`,
   * as FiveM's server does when it refreshes resources, and returns whether
   * its entries changed, as sameEntries compares them. When the manifest no
   * longer loads, the resource keeps the entries it added before it failed,
   * as in FiveM.
   */
  reloadMetadata(path: string): boolean {
    const { files, lua, output } = this.manager
    const root = normalizePath(path)
    let metadata: readonly MetadataEntry[]
    try {
      metadata = readManifest(lua, path, (file) => files.read(`${root}/${file}`))
    } catch (error) {
      if (!(error instanceof ManifestError)) throw error
      output.diagnose(
        this.name,
        `The manifest of ${this.name} no longer loads, and FiveM keeps the entries it added before it failed without saying so: ${error.message}`,
      )
      metadata = error.entries
    }
    const changed = !sameEntries(this.#metadata, metadata)
    this.#metadata = metadata
    if (changed) this.#diagnosePlurals()
    return changed
  }

  /** @internal Leaves the resource uninitialized, as FiveM does with the resources it removes. */
  destroy(): void {
    this.#state = 'uninitialized'
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
    return this.entries(key).flatMap((value) => glob(this.manager.files, this.#root, value).files)
  }

  /**
   * The manifest entries with `key` that name no files, with where they were
   * defined and whether every part they spell out exists, as FiveM's server
   * looks for them to warn about them.
   */
  missingEntries(key: string): MissingEntry[] {
    return this.metadata
      .filter(([name]) => name === key)
      .flatMap(([, value, location]) => {
        const { files, found } = glob(this.manager.files, this.#root, value)
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

  /** The bytes of the file at `path` in the resource, a normalized path, as the files of the process have it. */
  file(path: string): Uint8Array | undefined {
    return this.manager.files.read(`${this.#root}/${path}`)
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
    this.manager.pushCall(this, runtime)
    if (runtime !== null) this.#depth.set(runtime, (this.#depth.get(runtime) ?? 0) + 1)
    try {
      return fn()
    } finally {
      this.manager.popCall()
      if (runtime !== null) {
        const depth = this.#depth.get(runtime)! - 1
        if (depth > 0) {
          this.#depth.set(runtime, depth)
        } else {
          this.#depth.delete(runtime)
          if (this.#retired.delete(runtime)) this.#close(runtime)
        }
      }
    }
  }

  /** Says which entries of the resource's manifest have plural names, which FiveM does not read. */
  #diagnosePlurals(): void {
    for (const [[key, value, location], singular] of pluralEntries(this.#metadata)) {
      const where =
        location === undefined
          ? ''
          : ` (defined in ${location.file.slice(location.file.lastIndexOf('/') + 1)}:${location.line})`
      this.manager.output.diagnose(
        this.name,
        `${this.name}'s manifest adds ${key} \`${value}\`${where}, which FiveM does not read: ${key} drops its final s only for tables, so FiveM reads what ${singular} '...' and ${key} { '...' } add, but not ${key} '...'.`,
      )
    }
  }

  /** Files in the directory of the resource, as `files` names them. */
  #filesOf(files: Readonly<Record<string, string | Uint8Array>>): MemoryFileSystem {
    const own = new MemoryFileSystem()
    for (const [path, data] of Object.entries(files)) {
      addFile(own, normalizePath(`${this.#root}/${path}`), data)
    }
    return own
  }

  /**
   * Adds the files the resource was given to the files of the process, in
   * the directory of the resource, which it creates. Clients get only those
   * that FiveM's server sends them.
   */
  #addFiles(given: FileSystem): void {
    const { files, side } = this.manager
    const sent = side === 'client' ? clientFiles(given, this.#root, this.metadata) : undefined
    files.makeDirectory(this.#root)
    const add = (directory: string) => {
      for (const { name, directory: isDirectory } of given.list(directory) ?? []) {
        const path = `${directory}/${name}`
        if (isDirectory) add(path)
        else if (sent === undefined || sent.has(path.slice(this.#root.length + 1))) {
          addFile(files, path, given.read(path)!)
        }
      }
    }
    add(this.#root)
  }

  #packForClients(): void {
    const { files } = this.manager
    const packed: Record<string, Uint8Array> = {}
    for (const path of clientFiles(files, this.#root, this.#metadata)) {
      const data = files.read(`${this.#root}/${path}`)
      if (data !== undefined) packed[path] = data
    }
    const manifest = 'fxmanifest.lua' in packed || '__resource.lua' in packed
    this.#packed = manifest ? { files: packed } : { files: packed, metadata: this.#metadata }
  }

  /** Ends a start that a hook failed, as FiveM does. */
  #failStart(): false {
    if (this.#state !== 'started') this.#state = 'stopped'
    return false
  }

  /**
   * Creates the runtime and loads the scripts into it, as FiveM does for a
   * resource with scripts that its Lua runtime handles: those with ".lua" in
   * their name. On clients, it says when FiveM would give the scripts older
   * natives than FiveRunner does.
   */
  #createRuntime(): void {
    if (this.#runtime !== null) {
      this.manager.output.diagnose(
        this.name,
        `${this.name} was started while it started. FiveM would then create another runtime for it and load its scripts again in both runtimes, which FiveRunner does not emulate: it keeps the runtime it has.`,
      )
      return
    }
    const scripts = this.scripts
    for (const path of scripts) {
      if (!path.includes('.lua')) {
        this.manager.output.diagnose(
          this.name,
          `FiveRunner runs only Lua scripts, so it skips ${path}.`,
        )
      }
    }
    const lua = scripts.filter((path) => path.includes('.lua'))
    if (lua.length === 0) return
    this.manager.trace('citizen-scripting-core', `Creating script environments for ${this.name}\n`)
    if (this.manager.side === 'client') {
      const natives = clientNativesFile(this.metadata)
      if (natives !== 'natives_universal.lua') {
        this.manager.output.diagnose(
          this.name,
          `FiveM would give the scripts of ${this.name} the natives of ${natives}, by the versions its manifest names, which FiveRunner does not have: it gives them those of natives_universal.lua, as FiveM does for resources with fx_version 'adamant' or later.`,
        )
      }
    }
    const runtime = this.enter(() => ScriptRuntime.create(this.manager.lua, this.#host()))
    this.#runtime = runtime
    this.manager.addRuntime(this)
    for (const path of lua) {
      // A script that stopped the resource took the runtime the rest would load into.
      if (this.#runtime !== runtime) break
      const source = this.#openScript(path)
      const loaded = source !== undefined && this.enter(() => runtime.runFile(path, source))
      if (!loaded) this.manager.trace('citizen-scripting-core', `Failed to load script ${path}.\n`)
    }
  }

  /**
   * The source of a script, as FiveM's script host opens it: @resource/file
   * names a file of another resource, which need not have started.
   */
  #openScript(path: string): string | Uint8Array | undefined {
    const slash = path.indexOf('/')
    if (path.length > 1 && path.startsWith('@') && slash !== -1) {
      return this.manager
        .getResource(path.slice(1, slash))
        ?.file(normalizePath(path.slice(slash + 1)))
    }
    return this.file(normalizePath(path))
  }

  #destroyRuntime(): void {
    const runtime = this.#runtime
    if (runtime === null) return
    this.#runtime = null
    this.#context = null
    this.manager.removeRuntime(this)
    if (this.#depth.has(runtime)) this.#retired.add(runtime)
    else this.#close(runtime)
  }

  /**
   * Closes a runtime as FiveM destroys one: as a call into it, for the
   * finalizers that closing runs.
   */
  #close(runtime: ScriptRuntime): void {
    this.manager.pushCall(this, runtime)
    try {
      runtime.close()
    } finally {
      this.manager.popCall()
    }
  }

  #host(): ScriptHost {
    const { manager, name } = this
    return {
      resource: name,
      instanceId: manager.instanceId(),
      exports: this.entries(manager.side === 'server' ? 'server_export' : 'export'),
      natives: {
        client: manager.side === 'client',
        load: (native) => manager.nativeWrapper(native),
        invoke: (runtime, ptr) => manager.natives.invoke(this.#contextFor(runtime), ptr),
      },
      ...(manager.side === 'client'
        ? {}
        : {
            io: ioFiles(manager, name),
            os: {
              wallClock: () => manager.wallClock(),
              timeZone: manager.timeZone,
              processTime: () => manager.time(),
              steadyClock: () => manager.clock(),
              nextTemporaryName: () => manager.nextTemporaryName(),
              ...osFiles(manager, name),
            },
          }),
      clock: () => manager.clock(),
      trace: (text) => manager.log(`script:${name}`, text),
      warn: (message) => manager.output.warn(name, message),
      log: (channel, text) => manager.log(channel, text),
      diagnose: (message) => manager.output.diagnose(name, message),
      submitBoundary: (which, id) => manager.submitBoundary(which, id),
      formatStackTrace: () => manager.formatStackTrace(null) ?? '',
      invokeFunctionReference: (ref, args) => manager.invokeFunctionReference(ref, args),
    }
  }

  #contextFor(runtime: ScriptRuntime): NativeContext {
    if (this.#context?.runtime !== runtime) this.#context = new NativeContext(runtime, this)
    return this.#context
  }
}

/** Whether FiveM's server takes a name for that of a category of resources: one in brackets. */
export function isCategory(name: string): boolean {
  return name.startsWith('[') && name.endsWith(']')
}

/**
 * The categories of a resource at `path`: the directories in brackets right
 * above its own, the only ones that FiveM's server looks for resources in.
 */
function categoriesOf(path: string): string[] {
  const directories = path.split(/[\\/]/).filter((part) => part !== '')
  directories.pop()
  let first = directories.length
  while (first > 0 && isCategory(directories[first - 1]!)) first--
  return directories.slice(first)
}

/**
 * The files of a resource that FiveM's server sends clients, in its
 * resource.rpf: its manifest, and the files its file, client_script,
 * shared_script and map entries glob, but for those in stream/ that the
 * game streams, which have an extension that starts with .y, other than
 * .ytyp. Values with @ name files of other resources, which it leaves out.
 */
function clientFiles(
  files: FileSystem,
  root: string,
  metadata: readonly MetadataEntry[],
): Set<string> {
  const isCfxV2 = metadata.some(([key]) => key === 'is_cfxv2')
  const sent = [isCfxV2 ? 'fxmanifest.lua' : '__resource.lua']
  for (const key of ['file', 'client_script', 'shared_script', 'map']) {
    for (const [name, value] of metadata) {
      if (name !== key) continue
      for (const file of glob(files, root, value).files) if (!file.startsWith('@')) sent.push(file)
    }
  }
  return new Set(sent.filter((file) => !isStreamed(file)))
}

/**
 * Whether FiveM's server leaves a file in stream/ out for clients, by what
 * follows the first dot of its path, even when that dot is in a directory.
 */
function isStreamed(file: string): boolean {
  const dot = file.indexOf('.')
  if (!file.startsWith('stream/') || dot === -1) return false
  const extension = file.slice(dot)
  return extension[1] === 'y' && extension !== '.ytyp'
}
