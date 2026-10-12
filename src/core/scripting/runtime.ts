import {
  CFunction,
  type HostArgs,
  LuaError,
  LuaHostFunction,
  LuaRef,
  type LuaRuntime,
  type LuaState,
  type LuaValue,
  LuaVector,
} from '../lua/index.ts'
import type { NativeCaller } from '../natives/invoker.ts'
import eventsSource from './lua/events.lua?raw'
import exportsSource from './lua/exports.lua?raw'
import nativesSource from './lua/natives.lua?raw'
import refsSource from './lua/refs.lua?raw'
import schedulerSource from './lua/scheduler.lua?raw'
import deferredSource from './lua/vendor/deferred.lua?raw'

/** The natives a resource's scripts can call. */
export interface ScriptNatives {
  /** Whether Citizen.GetNative and Citizen.InvokeNative2 exist, as they do on FiveM clients. */
  readonly client: boolean
  /** The Lua code that defines the native called `name` in Global, or null if no native has that name. */
  load(name: string): string | null
  /** Runs a native call that cfxlua.wasm marshalled at `ptr` for a script of `runtime`. */
  invoke(runtime: ScriptRuntime, ptr: number): LuaValue[]
}

/**
 * Where hosts start the clock that threads wait by, in microseconds: a day.
 * FiveM's counts from when the machine started, which matters because FiveM
 * reads some delays as times on that clock, all long past.
 */
export const CLOCK_START = 86_400_000_000

/** What the scripts of one resource need from the game around them. */
export interface ScriptHost {
  /** The resource the scripts belong to. */
  readonly resource: string
  /** The id FiveM gives the runtime, which tells it from other runtimes of the resource. */
  readonly instanceId: number
  /**
   * The globals that the resource's manifest exports on the runtime's side,
   * in order: those its export entries name on clients, and its
   * server_export entries on servers.
   */
  readonly exports: readonly string[]
  readonly natives: ScriptNatives
  /**
   * The time on the clock that threads wait by, in whole microseconds from
   * CLOCK_START. It must not go back.
   */
  clock(): number
  /**
   * Writes to the resource's console: print, Citizen.Trace and script
   * errors. The text may hold FiveM colour codes (^1 and so on) and need not
   * end at a line break.
   */
  trace(text: string): void
  /** Reports a Lua warning: what warn() reports and errors in finalizers. */
  warn(message: string): void
  /** Writes to the console outside of the resource, on a channel such as citizen-scripting-core. */
  log(channel: string, text: string): void
  /** Reports a mistake in how a script uses FiveM that FiveLab noticed. */
  diagnose(message: string): void
  /**
   * Sets a boundary of the innermost call into a runtime, as FiveM's script
   * host keeps them for stack traces: its start, the thread the call
   * resumes, or its end, where the call last left the runtime, as
   * TriggerEvent does. Boundaries are ids the runtime gives; null clears one.
   */
  submitBoundary(which: keyof StackBoundaries, id: bigint | null): void
  /**
   * The stack trace of the runtimes that are running, as FiveM's
   * FORMAT_STACK_TRACE formats it for SCRIPT ERROR.
   */
  formatStackTrace(): string
  /**
   * Calls the function that a function reference names, as FiveM's script
   * host does: in the runtime that has it, with arguments that msgpack
   * packed. Returns the results packed, null if the runtime failed to call
   * the function, or undefined if no runtime has the reference.
   */
  invokeFunctionReference(ref: string, args: Uint8Array): Uint8Array | null | undefined
}

/** The boundaries of a call into a runtime; see ScriptHost.submitBoundary. */
export interface StackBoundaries {
  readonly start: bigint | null
  readonly end: bigint | null
}

/** A frame of a stack trace, as FiveM's Lua runtime gives them. */
export interface StackFrame {
  /** The name the caller knows the function by, or [global chunk]. */
  readonly name: string
  /** The name of the chunk, such as @resource/client.lua. */
  readonly file: string
  readonly line: number
}

/** Collects name and value pairs into a table. */
const TABLE = `local t = {}
for i = 1, select('#', ...), 2 do
    local name, value = select(i, ...)
    t[name] = value
end
return t`

/** Reads the entry points the FiveLab scripts leave in their shared table. */
const ENTRY_POINTS = `local fivelab = ...
return fivelab.collect, fivelab.resume, fivelab.runFile, fivelab.flush, fivelab.walkStack,
    fivelab.callRef, fivelab.duplicateRef, fivelab.deleteRef`

function release(...values: LuaValue[]): void {
  for (const value of values) if (value instanceof LuaRef) value.release()
}

function functionRef(value: LuaValue): LuaRef {
  if (value instanceof LuaRef && value.type === 'function') return value
  throw new TypeError('A FiveLab script did not provide an entry point')
}

/** A value to call as Lua would, failing as Lua does for numbers and the like. */
function callable(value: LuaValue): LuaRef | LuaHostFunction {
  if (value instanceof LuaRef || value instanceof LuaHostFunction) return value
  let type: string
  if (value === null || value === undefined) type = 'nil'
  else if (value instanceof LuaVector) type = value.type
  else if (value instanceof Uint8Array || typeof value === 'string') type = 'string'
  else if (typeof value === 'boolean') type = 'boolean'
  else type = 'number'
  throw new LuaError(`attempt to call a ${type} value`)
}

/**
 * The Lua runtime of one resource on one side, set up like FiveM's: CfxLua
 * with FiveM's libraries and require, the Citizen table with natives that load
 * on first use, the promise library, the Citizen scheduler with print,
 * events, function references and exports.
 */
export class ScriptRuntime implements NativeCaller {
  readonly state: LuaState
  readonly host: ScriptHost
  #collect: LuaRef | undefined
  #resume: LuaRef | undefined
  #runFile: LuaRef | undefined
  #flush: LuaRef | undefined
  #walkStack: LuaRef | undefined
  /** The frames walkStack collects while the scheduler walks them. */
  #walked: StackFrame[] | undefined
  #callRef: LuaRef | undefined
  #duplicateRef: LuaRef | undefined
  #deleteRef: LuaRef | undefined
  #resultAsObject: LuaRef | undefined
  /** What Citizen.ResultAsObject2 set to turn object results into Lua values. */
  #deserializer: LuaValue = null
  /** What Citizen.SetEventRoutine set first, which FiveM calls for each event. */
  #eventRoutine: LuaValue | undefined
  /** Natives without an implementation that the scripts called, by hash. */
  readonly #unimplemented = new Set<bigint>()

  private constructor(state: LuaState, host: ScriptHost) {
    this.state = state
    this.host = host
  }

  static create(runtime: LuaRuntime, host: ScriptHost): ScriptRuntime {
    const state = runtime.newState({ onWarning: (message) => host.warn(message) })
    const script = new ScriptRuntime(state, host)
    try {
      script.#init()
      return script
    } catch (error) {
      state.close()
      throw error
    }
  }

  get lua(): LuaRuntime {
    return this.state.runtime
  }

  /**
   * Loads and runs a script file of the resource as FiveM does: in its own
   * thread, so it may wait, with errors reported to the console. Returns
   * false if the file does not compile. `path` is relative to the resource,
   * or names a file of another resource as @resource/file.
   */
  runFile(path: string, source: string | Uint8Array): boolean {
    // Files of other resources, @resource/file, keep their name.
    const name = path.startsWith('@') ? path : `@${this.host.resource}/${path}`
    let chunk: LuaRef
    try {
      chunk = this.state.load(source, `@${name}`)
    } catch (error) {
      if (!(error instanceof LuaError)) throw error
      this.host.trace(
        `Error parsing script ${name} in resource ${this.host.resource}: ${error.message}\n`,
      )
      return false
    }
    try {
      this.state.call(this.#runFile!, chunk)
    } finally {
      chunk.release()
    }
    return true
  }

  /**
   * Takes the threads that are due out of the queue, for resume() to run. A
   * process collects in all of its runtimes before it resumes in any, as
   * FiveM does, so that threads queued during a tick wait for the next one.
   */
  collect(): void {
    this.state.call(this.#collect!)
  }

  /** Resumes the threads that collect() took, in the order they were queued. */
  resume(): void {
    this.state.call(this.#resume!)
  }

  /** Resumes the threads that are due, when the runtime is the only one to tick. */
  tick(): void {
    this.collect()
    this.resume()
  }

  close(): void {
    this.state.close()
  }

  /**
   * Calls the event routine with an event the resource gets, as FiveM's Lua
   * runtime does: with the event's name, its msgpack payload and its source.
   * FiveLab's events script sets the routine before any resource script
   * runs, as FiveM's scheduler does. Like FiveM, this reports errors.
   */
  triggerEvent(name: string, payload: Uint8Array, source: string): void {
    const routine = this.#eventRoutine
    if (routine === undefined) return
    try {
      this.state.call(callable(routine), name, payload, source)
    } catch (error) {
      if (!(error instanceof LuaError)) throw error
      this.#reportRoutineError('system event handling', error)
    } finally {
      this.state.call(this.#flush!)
    }
  }

  /**
   * Runs Citizen.ResultAsObject2's function on an object result. Like FiveM,
   * a failure is reported and reads as nil.
   */
  deserialize(bytes: Uint8Array): LuaValue {
    try {
      const [value = null] = this.state.call(callable(this.#deserializer), bytes)
      return value
    } catch (error) {
      if (!(error instanceof LuaError)) throw error
      this.#reportRoutineError('deserialization', error)
      return null
    }
  }

  /**
   * The frames of the thread the runtime is resuming, the innermost, as
   * FiveM's stack trace routine walks them: those of the call into the
   * runtime between its boundaries, past where it last left the runtime and
   * up to where it started. When the thread failed, or none is resuming, it
   * walks the runtime's main thread instead, where resource scripts seldom
   * run. Throws a LuaError if the walk fails, which describeRoutineError
   * describes as FiveM does.
   */
  walkStack(boundaries: StackBoundaries): StackFrame[] {
    if (this.state.dead !== undefined || this.state.closed) return []
    const walked = this.#walked
    const frames: StackFrame[] = []
    this.#walked = frames
    try {
      // FiveM calls its stack trace routine on the runtime's main thread.
      this.state.callOnMain(this.#walkStack!, boundaries.end, boundaries.start)
    } finally {
      this.#walked = walked
    }
    return frames
  }

  /**
   * Calls the function of the reference at `index` with arguments that
   * msgpack packed, as FiveM's call ref routine does, and returns its results
   * packed. The function runs in a thread of its own, which reports its
   * errors. Like FiveM, this reports errors of the routine itself, and then
   * gives null.
   */
  callRef(index: number, args: Uint8Array): Uint8Array | null {
    try {
      const options = { onMain: true, bytes: true }
      const [packed] = this.state.callWith(options, this.#callRef!, index, args)
      // The routine returns what msgpack.pack returns: a string.
      return packed as Uint8Array
    } catch (error) {
      if (!(error instanceof LuaError)) throw error
      this.#reportRoutineError('call reference', error)
      return null
    } finally {
      this.state.call(this.#flush!)
    }
  }

  /**
   * Counts another holder of the reference at `index`, as FiveM's ref
   * duplication routine does, and returns the index it keeps, or -1 for a
   * reference the runtime does not have. Like FiveM, this reports errors;
   * it then gives -1, where FiveM gives an index it never set.
   */
  duplicateRef(index: number): number {
    try {
      const [kept] = this.state.callOnMain(this.#duplicateRef!, index)
      return Number(kept)
    } catch (error) {
      if (!(error instanceof LuaError)) throw error
      this.#reportRoutineError('system ref duplication', error)
      return -1
    }
  }

  /**
   * Takes a holder of the reference at `index` away, as FiveM's ref deletion
   * routine does: the runtime forgets the function once none is left. Like
   * FiveM, this reports errors.
   */
  deleteRef(index: number): void {
    try {
      this.state.callOnMain(this.#deleteRef!, index)
    } catch (error) {
      if (!(error instanceof LuaError)) throw error
      this.#reportRoutineError('system ref deletion', error)
    }
  }

  /** How FiveM's Lua runtime reports an error in a routine it calls, such as the event routine. */
  describeRoutineError(routine: string, error: LuaError): string {
    const traceback = error.luaTraceback === undefined ? '' : `\n${error.luaTraceback}`
    return `Error running ${routine} function for resource ${this.host.resource}: ${error.message}${traceback}\n`
  }

  /** Reports an error in a routine the runtime calls, as FiveM's Lua runtime does. */
  #reportRoutineError(routine: string, error: LuaError): void {
    this.host.trace(this.describeRoutineError(routine, error))
  }

  trace(text: string): void {
    this.host.log('citizen-scripting-core', text)
  }

  diagnose(message: string): void {
    this.host.diagnose(message)
  }

  /** Says once for each native that the scripts called it but FiveLab does not implement it. */
  unimplemented(name: string, hash: bigint): void {
    if (this.#unimplemented.has(hash)) return
    this.#unimplemented.add(hash)
    this.host.diagnose(
      `${name} is not implemented in FiveLab yet: it does nothing and returns zero values.`,
    )
  }

  #init(): void {
    const { state, host } = this
    const require = state.requireFunction()
    state.setGlobal('require', require)
    require.release()
    const citizen = this.#citizen()
    state.setGlobal('Citizen', citizen)
    release(citizen)
    state.run(nativesSource, '@fivelab:/natives.lua')

    const [promise] = state.run(deferredSource, '@fivelab:/deferred.lua')
    state.setGlobal('promise', promise)
    release(promise)

    const write = state.hostFunction((args) => {
      host.trace(String(args.get(1)))
    })
    const print = state.cFunction(CFunction.print, write)
    const trace = state.cFunction(CFunction.trace, write)
    const checked = state.cFunction(CFunction.checked)
    const [hostTable] = state.run(
      TABLE,
      '=fivelab:host',
      'clock',
      state.hostFunction(() => host.clock()),
      'trace',
      write,
      'print',
      print,
      'Trace',
      trace,
      'checked',
      checked,
      'server',
      !host.natives.client,
      'resource',
      host.resource,
      'manifestExports',
      state.hostFunction(() => host.exports),
      'formatStackTrace',
      state.hostFunction(() => host.formatStackTrace()),
      'clearBoundaryStart',
      state.hostFunction(() => host.submitBoundary('start', null)),
      'stackFrame',
      state.hostFunction((args) => {
        const [name, file, line] = args.all()
        this.#walked?.push({ name: String(name), file: String(file), line: Number(line) })
      }),
    )
    release(print, trace, checked)
    const [fivelab] = state.run('return {}', '=fivelab:shared')
    state.run(schedulerSource, '@fivelab:/scheduler.lua', hostTable, fivelab)
    state.run(eventsSource, '@fivelab:/events.lua', hostTable, fivelab)
    state.run(refsSource, '@fivelab:/refs.lua', hostTable, fivelab)
    state.run(exportsSource, '@fivelab:/exports.lua', hostTable)
    const [collect, resume, runFile, flush, walkStack, callRef, duplicateRef, deleteRef] =
      state.run(ENTRY_POINTS, '=fivelab:entry', fivelab)
    release(hostTable, fivelab)
    this.#collect = functionRef(collect)
    this.#resume = functionRef(resume)
    this.#runFile = functionRef(runFile)
    this.#flush = functionRef(flush)
    this.#walkStack = functionRef(walkStack)
    this.#callRef = functionRef(callRef)
    this.#duplicateRef = functionRef(duplicateRef)
    this.#deleteRef = functionRef(deleteRef)
    state.setGlobal('dofile', null)
    state.setGlobal('loadfile', null)
  }

  /** The Citizen table as FiveM creates it, before its scripts add to it. */
  #citizen(): LuaValue {
    const { state, host } = this
    const invoker = state.hostFunction((args) => host.natives.invoke(this, Number(args.get(1))))
    const marker = state.cFunction(CFunction.resultAsObject)
    const [resultAsObject] = state.call(marker)
    marker.release()
    this.#resultAsObject = resultAsObject as LuaRef
    const checked = state.cFunction(CFunction.checked)
    /** A C function that checks its arguments as `checks` says, then calls `fn`; see checked. */
    const check = (checks: string, fn: LuaHostFunction) => state.call(checked, checks, fn)[0]!
    const functions: [string, LuaValue][] = [
      ['InvokeNative', state.cFunction(CFunction.invokeNative, invoker)],
      ['LoadNative', state.hostFunction((args) => this.#loadNative(args))],
      ['PointerValueIntInitialized', state.cFunction(CFunction.pointerValueIntInitialized)],
      ['PointerValueFloatInitialized', state.cFunction(CFunction.pointerValueFloatInitialized)],
      ['PointerValueInt', state.cFunction(CFunction.pointerValueInt)],
      ['PointerValueFloat', state.cFunction(CFunction.pointerValueFloat)],
      ['PointerValueVector', state.cFunction(CFunction.pointerValueVector)],
      ['ReturnResultAnyway', state.cFunction(CFunction.returnResultAnyway)],
      ['ResultAsInteger', state.cFunction(CFunction.resultAsInteger)],
      ['ResultAsLong', state.cFunction(CFunction.resultAsLong)],
      ['ResultAsFloat', state.cFunction(CFunction.resultAsFloat)],
      ['ResultAsString', state.cFunction(CFunction.resultAsString)],
      ['ResultAsVector', state.cFunction(CFunction.resultAsVector)],
      ['ResultAsObject', state.cFunction(CFunction.noop)],
      [
        'ResultAsObject2',
        state.hostFunction((args) => {
          release(this.#deserializer)
          this.#deserializer = args.get(1)
          return this.#resultAsObject
        }),
      ],
      [
        'SetEventRoutine',
        state.hostFunction((args) => {
          // FiveM keeps the first routine set, and ignores the others.
          const routine = args.get(1) ?? null
          if (this.#eventRoutine === undefined) this.#eventRoutine = routine
          else release(routine)
        }),
      ],
      ['AwaitSentinel', state.cFunction(CFunction.awaitSentinel)],
      [
        'SubmitBoundaryStart',
        state.hostFunction((args) => host.submitBoundary('start', args.integer(1))),
      ],
      [
        'SubmitBoundaryEnd',
        state.hostFunction((args) => host.submitBoundary('end', args.integer(1))),
      ],
      [
        'CanonicalizeRef',
        check(
          'i',
          state.hostFunction(
            (args) => `${host.resource}:${host.instanceId}:${BigInt.asIntN(32, args.integer(1))}`,
          ),
        ),
      ],
      [
        'InvokeFunctionReference',
        // FiveM checks the arguments before the reference, which it reads
        // up to its first NUL.
        check(
          '<ss',
          state.hostFunction((args) => {
            const ref = String(args.get(1)).split('\0', 1)[0]!
            const results = host.invokeFunctionReference(ref, args.bytes(2)!)
            if (results !== undefined) return results
            // FiveM ends the message with the last error of the script host,
            // which natives set when they fail through it: those of other
            // languages, and of use_experimental_fxv2_oal on servers. FiveLab
            // has none of them yet.
            throw new LuaError('Execution of function reference in script host failed: ')
          }),
        ),
      ],
      // FiveM ignores tick routines. It keeps the first of the other
      // routines it is given, which its scheduler gives before any resource
      // script runs, so calls from scripts change nothing.
      ['SetTickRoutine', state.cFunction(CFunction.noop)],
      ['SetBoundaryRoutine', state.cFunction(CFunction.noop)],
      ['SetStackTraceRoutine', state.cFunction(CFunction.noop)],
      ['SetCallRefRoutine', state.cFunction(CFunction.noop)],
      ['SetDuplicateRefRoutine', state.cFunction(CFunction.noop)],
      ['SetDeleteRefRoutine', state.cFunction(CFunction.noop)],
    ]
    if (host.natives.client) {
      functions.push(
        ['GetNative', state.cFunction(CFunction.getNative, invoker)],
        ['InvokeNative2', state.cFunction(CFunction.invokeNative2, invoker)],
      )
    }
    const [citizen] = state.run(TABLE, '=fivelab:citizen', ...functions.flat())
    release(checked, ...functions.map(([, value]) => value))
    return citizen ?? null
  }

  /**
   * Citizen.LoadNative, for the loader in natives.lua. Like FiveM's, it takes
   * numbers as names (no native has one) and rejects other values, so that
   * looking up a missing global under a key such as true fails.
   */
  #loadNative(args: HostArgs): string | null {
    const type = args.typeName(1)
    if (type === 'string') return this.host.natives.load(String(args.get(1)))
    if (type === 'number') return null
    throw new LuaError(`bad argument #1 to 'LoadNative' (string expected, got ${type})`)
  }
}
