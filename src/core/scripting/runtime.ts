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
import nativesSource from './lua/natives.lua?raw'
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
return fivelab.collect, fivelab.resume, fivelab.runFile, fivelab.flush`

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
 * on first use, the promise library, the Citizen scheduler with print, and
 * events.
 */
export class ScriptRuntime implements NativeCaller {
  readonly state: LuaState
  readonly host: ScriptHost
  #collect: LuaRef | undefined
  #resume: LuaRef | undefined
  #runFile: LuaRef | undefined
  #flush: LuaRef | undefined
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

  /** Reports an error in a function the runtime calls, as FiveM's Lua runtime does. */
  #reportRoutineError(routine: string, error: LuaError): void {
    const traceback = error.luaTraceback === undefined ? '' : `\n${error.luaTraceback}`
    this.host.trace(
      `Error running ${routine} function for resource ${this.host.resource}: ${error.message}${traceback}\n`,
    )
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
    )
    release(print, trace, checked)
    const [fivelab] = state.run('return {}', '=fivelab:shared')
    state.run(schedulerSource, '@fivelab:/scheduler.lua', hostTable, fivelab)
    state.run(eventsSource, '@fivelab:/events.lua', hostTable, fivelab)
    const [collect, resume, runFile, flush] = state.run(ENTRY_POINTS, '=fivelab:entry', fivelab)
    release(hostTable, fivelab)
    this.#collect = functionRef(collect)
    this.#resume = functionRef(resume)
    this.#runFile = functionRef(runFile)
    this.#flush = functionRef(flush)
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
      // FiveM ignores tick routines. It keeps the first boundary and stack
      // trace routines it is given, which its scheduler gives before any
      // resource script runs, so calls from scripts change nothing.
      ['SetTickRoutine', state.cFunction(CFunction.noop)],
      ['SetBoundaryRoutine', state.cFunction(CFunction.noop)],
      ['SetStackTraceRoutine', state.cFunction(CFunction.noop)],
    ]
    if (host.natives.client) {
      functions.push(
        ['GetNative', state.cFunction(CFunction.getNative, invoker)],
        ['InvokeNative2', state.cFunction(CFunction.invokeNative2, invoker)],
      )
    }
    const [citizen] = state.run(TABLE, '=fivelab:citizen', ...functions.flat())
    release(...functions.map(([, value]) => value))
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
