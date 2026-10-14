import {
  addAccessCommands,
  addConvarPermissionCommands,
  addPrinterCommands,
  ConsoleContext,
  ConvarPermissions,
  EVERYONE,
  Printer,
  Security,
} from '../console/index.ts'
import { LuaError, type LuaRuntime } from '../lua/index.ts'
import {
  catalogNatives,
  NativeRegistry,
  nativeWrapper,
  type NativeDefinition,
  type Side,
} from '../natives/index.ts'
import { CLOCK_START, type ScriptRuntime, type StackBoundaries } from '../scripting/runtime.ts'
import { ConsoleBuffer } from './buffer.ts'
import { CALLBACK_RESOURCE, Callbacks } from './callbacks.ts'
import { addConfigCommands } from './config.ts'
import { addResourceCommands } from './control.ts'
import { Constraints, DEFAULT_GAME_BUILD, FIVEM_BUILD, parseGameBuild } from './constraints.ts'
import type { NativeContext } from './context.ts'
import { Dependencies } from './dependencies.ts'
import { EventManager } from './events.ts'
import { MemoryFileSystem, type FileSystem } from './files.ts'
import { normalizePath } from './glob.ts'
import { INT32_MIN } from './hook.ts'
import { KvpStore } from './kvp.ts'
import { atoi, compareUtf8, strtoull } from '../libc.ts'
import { isFxVersionAtLeast } from './manifest.ts'
import { arrayLength } from './msgpack.ts'
import { addPermissionCommands, FilesystemPermissions } from './permissions.ts'
import { engineNatives } from './natives/index.ts'
import { Resource, type ResourceDefinition } from './resource.ts'
import { ResourceScanner } from './scan.ts'
import type { Player, Session } from './session.ts'

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
  /** The KVP of the resources, which FiveM keeps in a database: an empty one by default. */
  readonly kvp?: KvpStore
  /**
   * The files of the process, which its resources are in: on servers, the
   * directory FiveM's server runs in, and on clients, what servers sent,
   * where FiveM mounts it. Empty files in memory by default.
   */
  readonly files?: FileSystem
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
  /** What the process's code may access, as FiveM's security keeps it. */
  readonly security = new Security()
  /** What prints on the process's console, as FiveM's console prints it. */
  readonly printer: Printer
  /** The process's default console, which FiveM's GetDefaultContext gives. */
  readonly defaultConsole: ConsoleContext
  /**
   * The console that scripts run commands in, and whose buffer runs each
   * tick: on servers, that of the server instance, which runs the commands
   * it does not have in the default console, and on clients, the default
   * console.
   */
  readonly console: ConsoleContext
  /** On servers, which resources may read the console variables that are restricted to some. */
  readonly convarPermissions: ConvarPermissions | undefined
  /** On servers, which resources may write the files of others. */
  readonly filesystemPermissions: FilesystemPermissions | undefined
  /** On servers, what they keep of what their console prints for scripts. */
  readonly consoleBuffer: ConsoleBuffer | undefined
  /** The KVP of the resources, in the database of the process. */
  readonly kvp: KvpStore
  /** The files of the process, which its resources are in. */
  readonly files: FileSystem
  /** On servers, whether OneSync is on. */
  readonly oneSync: boolean
  readonly natives = new NativeRegistry<NativeContext>()
  readonly events = new EventManager(this)
  /** The callbacks of the process's own code that scripts call as functions. */
  readonly callbacks = new Callbacks()
  /** What dependencies such as /server:5181 test, which only servers enforce. */
  readonly constraints = new Constraints()
  readonly #dependencies = new Dependencies(this)
  /** On servers, what finds the resources of their resources directory. */
  readonly #scanner: ResourceScanner | undefined
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
  #configured = false
  #session: Session | undefined
  #player: Player | undefined

  constructor(options: ResourceManagerOptions) {
    this.side = options.side
    this.lua = options.lua
    this.output = options.output
    this.#time = options.time
    this.kvp = options.kvp ?? new KvpStore()
    this.files = options.files ?? new MemoryFileSystem()
    this.oneSync = this.side === 'server' && (options.oneSync ?? true)
    this.printer = new Printer((channel, text) => this.output.write(channel, text))
    const server = this.side === 'server'
    if (server) {
      const buffer = new ConsoleBuffer(this)
      this.printer.listen((channel, text) => buffer.add(channel, text))
      this.consoleBuffer = buffer
    } else {
      this.consoleBuffer = undefined
    }
    const consoleOptions = {
      security: this.security,
      output: this.printer,
      server,
      clock: () => this.#time(),
    }
    this.defaultConsole = new ConsoleContext(consoleOptions)
    addPrinterCommands(this.defaultConsole, this.printer)
    addAccessCommands(this.defaultConsole)
    // FiveM's security starts with this entry.
    this.security.addEntry('system.console', 'command', 'allow')
    if (server) {
      this.convarPermissions = new ConvarPermissions()
      addConvarPermissionCommands(this.defaultConsole, this.convarPermissions)
      this.filesystemPermissions = new FilesystemPermissions()
      addPermissionCommands(this, this.filesystemPermissions)
      this.console = new ConsoleContext({ ...consoleOptions, fallback: this.defaultConsole })
      this.#scanner = new ResourceScanner(this)
      addConfigCommands(this)
      addResourceCommands(this)
      this.#startServerConsole()
    } else {
      // FiveM's client lets its own code set what servers replicate, among others.
      this.security.addEntry('system.internal', 'builtin', 'allow')
      this.convarPermissions = undefined
      this.filesystemPermissions = undefined
      this.#scanner = undefined
      this.console = this.defaultConsole
      // FiveM's NUI console listens to the variables first, for its main menu, which FiveLab has not.
      this.console.variables.watch(() => {})
    }
    this.natives.register(
      ...catalogNatives<NativeContext>(this.side),
      ...engineNatives(this.side),
      ...(options.natives ?? []),
    )
    if (this.side === 'server') {
      this.#registerConstraints(this.oneSync, options.gameBuild ?? DEFAULT_GAME_BUILD)
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
   * Removes a resource, as FiveM's server does with one it finds elsewhere
   * than before: it stops it, and leaves it uninitialized. Like FiveM, it
   * still finds the resource by the names that it provides.
   */
  removeResource(resource: Resource): void {
    resource.stop()
    resource.destroy()
    this.#resources.delete(resource.name)
  }

  /**
   * Scans the resources directory of a server for resources, as FiveM's
   * server does as it starts, before it runs its config, and when its
   * refresh command runs; see ResourceScanner.scan.
   */
  scanResources(): void {
    if (this.#scanner === undefined) throw new Error('Only servers scan for resources')
    this.#scanner.scan()
  }

  /**
   * The bytes of the file at `path`, as FiveM's server opens the files its
   * commands name: @name/ is the directory of the resource that scans found
   * by the name, and other paths are those of the files of the process.
   */
  readFile(path: string): Uint8Array | undefined {
    return this.files.read(normalizePath(this.#scanner?.resolve(path) ?? path))
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

  /** The names of the resources in a category, such as [local], in the order of their bytes. */
  resourcesInCategory(category: string): string[] {
    return Array.from(this.#resources.values())
      .filter((resource) => resource.categories.includes(category))
      .map((resource) => resource.name)
      .sort(compareUtf8)
  }

  /** The session the process is in: on servers, the one they host, and on clients, the one they connected to. */
  get session(): Session | undefined {
    return this.#session
  }

  /** On clients, the player that their server knows them as, once they connected to it. */
  get player(): Player | undefined {
    return this.#player
  }

  /** @internal Called by the session that the process joins. */
  joinSession(session: Session, player?: Player): void {
    this.#session = session
    this.#player = player
  }

  /** @internal Called by the session that dropped the player of a client. */
  leaveSession(): void {
    this.#session = undefined
    this.#player = undefined
  }

  /**
   * Whether the server ended its initial configuration; see
   * endInitialConfiguration.
   */
  get configured(): boolean {
    return this.#configured
  }

  /**
   * Ends the initial configuration of a server, as FiveM's server does once
   * it ran its command line, and the config files that this executes: from
   * then on, ensure restarts the resources that are started.
   */
  endInitialConfiguration(): void {
    this.#configured = true
  }

  /**
   * The runtime that a function reference names, and the index of the
   * reference in it, as FiveM looks references up: by the resource, or one
   * that provides its name, and the id of the runtime it runs.
   */
  lookUpRef(ref: string): FoundRef | undefined {
    const { resource: name, instance, index } = parseRef(ref)
    // The callbacks of FiveM's own code have no runtime of a resource.
    if (name === CALLBACK_RESOURCE) return undefined
    const resource = this.getResource(name)
    const runtime = resource?.runtime
    if (resource === undefined || runtime == null || runtime.host.instanceId !== instance) {
      return undefined
    }
    return { resource, runtime, index }
  }

  /**
   * Calls the function that a function reference names, as FiveM's script
   * host does: in the runtime that lookUpRef finds, or the callback of the
   * process's own code for _cfx_internal, with arguments that msgpack
   * packed. Returns the results packed, null if the runtime failed to call
   * the function, or undefined if no runtime has the reference.
   */
  invokeFunctionReference(ref: string, args: Uint8Array): Uint8Array | null | undefined {
    const { resource: name, index: callback } = parseRef(ref)
    if (name === CALLBACK_RESOURCE) return this.callbacks.call(callback, args)
    const found = this.lookUpRef(ref)
    if (found === undefined) return undefined
    const { resource, runtime, index } = found
    return resource.enter(() => runtime.callRef(index, args))
  }

  /**
   * Counts another holder of the function that a function reference names,
   * as FiveM's script host does, and returns the reference the holder
   * keeps, or null if no runtime has the reference.
   */
  duplicateFunctionReference(ref: string): string | null {
    const { resource: name, index: callback } = parseRef(ref)
    if (name === CALLBACK_RESOURCE) return this.callbacks.duplicate(callback)
    const found = this.lookUpRef(ref)
    if (found === undefined) return null
    const { resource, runtime, index } = found
    // FiveM names the runtime's resource, which may provide the name the reference has.
    const kept = resource.enter(() => runtime.duplicateRef(index))
    return `${resource.name}:${runtime.host.instanceId}:${kept}`
  }

  /** Takes a holder of the function that a function reference names away, as FiveM's script host does. */
  deleteFunctionReference(ref: string): void {
    const { resource: name, index: callback } = parseRef(ref)
    if (name === CALLBACK_RESOURCE) {
      this.callbacks.delete(callback)
      return
    }
    const found = this.lookUpRef(ref)
    if (found === undefined) return
    const { resource, runtime, index } = found
    resource.enter(() => runtime.deleteRef(index))
  }

  /**
   * Runs a tick as FiveM does: it runs the commands of the console's buffer
   * as the console, triggers the queued events, then resumes the threads
   * that are due in all runtimes. It takes the due threads of every runtime
   * before it resumes any, so that threads queued during the tick wait for
   * the next one. A client tells its server it is there first, as FiveM's
   * do with the packets they send every frame.
   */
  tick(): void {
    this.#player?.touch()
    this.security.runAs('system.console', () => this.console.executeBuffer())
    this.events.tick()
    const ticking = this.#ticking.map((resource) => ({ resource, runtime: resource.runtime! }))
    for (const { runtime } of ticking) runtime.collect()
    for (const { resource, runtime } of ticking) {
      // A runtime closed by a thread that ran before it has nothing to resume.
      if (resource.runtime === runtime) resource.enter(() => runtime.resume())
    }
  }

  /** Prints on the console on `channel`, as FiveM's console::Printf does; see Printer. */
  log(channel: string, text: string): void {
    this.printer.print(channel, text)
  }

  /**
   * Prints on the console on `channel`, as FiveM's trace does: the text up
   * to its first NUL, as trace passes it on as a C string.
   */
  trace(channel: string, text: string): void {
    this.printer.print(channel, text.split('\0', 1)[0]!)
  }

  /** Prints a warning on the console on `channel`, as FiveM's console::PrintWarning does. */
  logWarning(channel: string, text: string): void {
    this.printer.printWarning(channel, text)
  }

  /** Prints an error on the console on `channel`, as FiveM's console::PrintError does. */
  logError(channel: string, text: string): void {
    this.printer.printError(channel, text)
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
   * Sets up the security and the console of a server as FiveM's server does
   * as it starts, before it runs its command line.
   */
  #startServerConsole(): void {
    const { security } = this
    security.addEntry('system.console', 'command', 'allow')
    security.addEntry(EVERYONE, 'command.help', 'allow')
    security.runAs('system.console', () => {
      // FiveM keeps what commands that it forwards print from its console.
      this.console.executeDirect(['con_addChannelFilter', 'forward:*/*', 'noprint'])
    })
    security.addEntry('system.console', 'webadmin', 'allow')
    security.addEntry('resource.monitor', 'command.quit', 'allow')
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
