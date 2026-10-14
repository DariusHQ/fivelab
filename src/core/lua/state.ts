import {
  CFunction,
  LUA_MULTRET,
  LUA_OK,
  LUA_TBOOLEAN,
  LUA_TFUNCTION,
  LUA_TLIGHTUSERDATA,
  LUA_TMATRIX,
  LUA_TNIL,
  LUA_TNONE,
  LUA_TNUMBER,
  LUA_TSTRING,
  LUA_TTABLE,
  LUA_TTHREAD,
  LUA_TUSERDATA,
  LUA_TVECTOR,
  LUA_GCCOLLECT,
  VECTOR_KIND,
  type Ptr,
} from './abi.ts'
import {
  isStackOverflow,
  LuaArgumentError,
  LuaCallerError,
  LuaError,
  LuaFatalError,
} from './errors.ts'
import type { LuaRuntime } from './runtime.ts'
import { LuaFloat, LuaVector, type LuaVectorType } from './values.ts'

export type LuaRefType = 'table' | 'function' | 'userdata' | 'thread' | 'matrix'

/**
 * Values that cross between JavaScript and Lua. nil reads as null; undefined
 * and null both push nil. Strings read as UTF-8. Integers outside the safe
 * range read as bigint. Integral numbers push as integers, unless wrapped in
 * LuaFloat. Tables, functions, userdata, threads and matrices read as LuaRef.
 */
export type LuaValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | LuaVector
  | LuaFloat
  | LuaRef
  | LuaHostFunction

/** No value, one value, or several results. */
export type HostResult = LuaValue | readonly LuaValue[] | void

export type HostFunction = (args: HostArgs) => HostResult

export interface WatchdogOptions {
  /** Raise an error in a script that runs this long without returning. */
  readonly timeoutMs: number
  /**
   * Stop the state if the script keeps running this long, because it caught
   * the errors. Defaults to twice the timeout.
   */
  readonly killAfterMs?: number
  /** Instructions between checks. Defaults to 1000. */
  readonly interval?: number
}

export interface CallOptions {
  /**
   * Call on the main thread even inside a host call from a coroutine, as C
   * code calls functions on a state it kept rather than on the thread that
   * called it.
   */
  readonly onMain?: boolean
  /** Return strings as their bytes, keeping binary data such as msgpack. */
  readonly bytes?: boolean
}

/**
 * Calls from JavaScript into Lua and back nest on one native stack, which
 * overflows long before Lua's own C stack limit when several states call each
 * other. Past this depth a call fails with an ordinary error instead.
 */
export const MAX_NESTED_CALLS = 64

/** The largest allocation limit; size_t is 32 bits in the module. */
const MAX_MEMORY_LIMIT = 0xffff_ffff

let nestedCalls = 0

const VECTOR_TYPES: Record<number, LuaVectorType> = {
  [VECTOR_KIND.vector2]: 'vector2',
  [VECTOR_KIND.vector3]: 'vector3',
  [VECTOR_KIND.vector4]: 'vector4',
  [VECTOR_KIND.quat]: 'quat',
}

const REF_TYPES: Record<number, LuaRefType> = {
  [LUA_TTABLE]: 'table',
  [LUA_TFUNCTION]: 'function',
  [LUA_TUSERDATA]: 'userdata',
  [LUA_TLIGHTUSERDATA]: 'userdata',
  [LUA_TTHREAD]: 'thread',
  [LUA_TMATRIX]: 'matrix',
}

const TYPE_NAMES: Record<number, string> = {
  [LUA_TNONE]: 'no value',
  [LUA_TNIL]: 'nil',
  [LUA_TBOOLEAN]: 'boolean',
  [LUA_TLIGHTUSERDATA]: 'light userdata',
  [LUA_TNUMBER]: 'number',
  [LUA_TVECTOR]: 'vector',
  [LUA_TSTRING]: 'string',
  [LUA_TTABLE]: 'table',
  [LUA_TFUNCTION]: 'function',
  [LUA_TUSERDATA]: 'userdata',
  [LUA_TTHREAD]: 'thread',
  [LUA_TMATRIX]: 'matrix',
}

/** The message Lua receives for an exception thrown by a host function. */
function errorMessage(error: unknown): string {
  if (
    error instanceof LuaError ||
    error instanceof LuaArgumentError ||
    error instanceof LuaCallerError
  ) {
    return error.message
  }
  try {
    return String(error)
  } catch {
    return 'host function threw a value that cannot be converted to a string'
  }
}

/** A Lua value held in the registry of its state until released. */
export class LuaRef {
  readonly state: LuaState
  readonly type: LuaRefType
  #ref: number

  constructor(state: LuaState, ref: number, type: LuaRefType) {
    this.state = state
    this.type = type
    this.#ref = ref
  }

  /** The registry reference, or -1 once released. */
  get ref(): number {
    return this.#ref
  }

  call(...args: LuaValue[]): LuaValue[] {
    return this.state.call(this, ...args)
  }

  release(): void {
    if (this.#ref < 0) return
    const ref = this.#ref
    this.#ref = -1
    this.state.unref(this, ref)
  }
}

/** A JavaScript function exposed to one Lua state. */
export class LuaHostFunction {
  readonly state: LuaState
  readonly id: number

  constructor(state: LuaState, id: number) {
    this.state = state
    this.id = id
  }
}

/** The arguments of a host function call, read from the Lua stack. Indices start at 1. */
export class HostArgs {
  readonly state: LuaState
  readonly L: Ptr
  readonly count: number

  constructor(state: LuaState, L: Ptr, count: number) {
    this.state = state
    this.L = L
    this.count = count
  }

  /** The Lua type code of an argument (LUA_TNONE past the end). */
  type(index: number): number {
    return this.state.runtime.exports.fl_type(this.L, index)
  }

  /** The type of an argument as Lua's argument errors name it: "no value", "light userdata" and so on. */
  typeName(index: number): string {
    return TYPE_NAMES[this.type(index)] ?? 'userdata'
  }

  get(index: number): LuaValue {
    return this.state.read(this.L, index)
  }

  all(): LuaValue[] {
    const values: LuaValue[] = []
    for (let i = 1; i <= this.count; i++) values.push(this.state.read(this.L, i))
    return values
  }

  /**
   * An argument as lua_tointeger reads it: an integer, or a float or a
   * string that converts to one exactly; any other value reads as 0.
   */
  integer(index: number): bigint {
    return this.state.runtime.exports.fl_tointeger64(this.L, index)
  }

  /** The raw bytes of a string argument, or null for other types. */
  bytes(index: number): Uint8Array | null {
    if (this.type(index) !== LUA_TSTRING) return null
    return this.state.readBytes(this.L, index)
  }
}

/**
 * One Lua state (one FiveM script runtime) inside a LuaRuntime.
 *
 * Every call into Lua is protected: a Lua error becomes a LuaError and the
 * state keeps working. When Lua runs a host function that calls back into its
 * own state, the nested call runs on the calling thread, as it would from C.
 */
export class LuaState {
  readonly runtime: LuaRuntime
  readonly id: number
  /** The main thread. */
  readonly L: Ptr
  readonly #functions: HostFunction[] = []
  readonly #threads: Ptr[] = []
  readonly #finalizer = new FinalizationRegistry<number>((ref) => this.#release(ref))
  readonly #onWarning: ((message: string) => void) | undefined
  readonly #warningDecoder = new TextDecoder()
  #warning = ''
  #entries = 0
  #sliceStart = 0
  #watchdog: Required<WatchdogOptions> | undefined
  #closed = false
  #dead: LuaFatalError | undefined

  constructor(runtime: LuaRuntime, id: number, L: Ptr, onWarning?: (message: string) => void) {
    this.runtime = runtime
    this.id = id
    this.L = L
    this.#onWarning = onWarning
  }

  /** The error that stopped this state, if any. */
  get dead(): LuaFatalError | undefined {
    return this.runtime.crashed ?? this.#dead
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Bytes allocated by this state. */
  get memoryUsed(): number {
    this.#checkOpen()
    return this.runtime.exports.fl_memused(this.L) >>> 0
  }

  /** Allocation limit in bytes; 0 means unlimited. Allocations past it raise memory errors. */
  get memoryLimit(): number {
    this.#checkOpen()
    return this.runtime.exports.fl_getmemlimit(this.L) >>> 0
  }

  set memoryLimit(bytes: number) {
    this.#checkOpen()
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_MEMORY_LIMIT) {
      throw new RangeError(`Invalid memory limit: ${bytes}`)
    }
    this.runtime.exports.fl_setmemlimit(this.L, bytes)
  }

  openLibs(mask: number): void {
    this.#enter((L) => {
      const ex = this.runtime.exports
      const top = ex.fl_gettop(L)
      const status = ex.fl_openlibs(L, mask)
      if (status !== LUA_OK) throw this.#popError(L, status, top, false)
    })
  }

  /** Compiles a chunk. `chunkname` follows Lua: "@file.lua", "=name" or the source itself. */
  load(source: string | Uint8Array, chunkname: string, mode: 't' | 'b' | 'bt' = 'bt'): LuaRef {
    const chunk = typeof source === 'string' ? new TextEncoder().encode(source) : source
    return this.#enter((L) => {
      const ex = this.runtime.exports
      const top = ex.fl_gettop(L)
      const status = this.runtime.withChunk(chunk, chunkname, mode, (buf, length, name, modePtr) =>
        ex.fl_load(L, buf, length, name, modePtr),
      )
      if (status !== LUA_OK) throw this.#popError(L, status, top, false)
      return this.#popRef(L)
    })
  }

  /** Compiles and runs a chunk, returning its results. */
  run(source: string | Uint8Array, chunkname: string, ...args: LuaValue[]): LuaValue[] {
    const fn = this.load(source, chunkname)
    try {
      return this.call(fn, ...args)
    } finally {
      fn.release()
    }
  }

  /** Calls a Lua value in protected mode and returns all of its results. */
  call(fn: LuaRef | LuaHostFunction, ...args: LuaValue[]): LuaValue[] {
    return this.callWith({}, fn, ...args)
  }

  /** Calls a Lua value as call does, but on the main thread (see CallOptions). */
  callOnMain(fn: LuaRef | LuaHostFunction, ...args: LuaValue[]): LuaValue[] {
    return this.callWith({ onMain: true }, fn, ...args)
  }

  /** Calls a Lua value as call does, in the ways `options` says. */
  callWith(options: CallOptions, fn: LuaRef | LuaHostFunction, ...args: LuaValue[]): LuaValue[] {
    return this.#enter(
      (L) => {
        const ex = this.runtime.exports
        const base = ex.fl_gettop(L)
        this.push(L, fn)
        for (const arg of args) this.push(L, arg)
        const status = ex.fl_pcall(L, args.length, LUA_MULTRET)
        if (status !== LUA_OK) throw this.#popError(L, status, base, true)
        const top = ex.fl_gettop(L)
        const results: LuaValue[] = []
        for (let i = base + 1; i <= top; i++) {
          const bytes = options.bytes === true && ex.fl_type(L, i) === LUA_TSTRING
          results.push(bytes ? this.readBytes(L, i) : this.read(L, i))
        }
        ex.fl_settop(L, base)
        return results
      },
      options.onMain === true ? this.L : undefined,
    )
  }

  /** Reads a global without invoking metamethods. */
  getGlobal(name: string): LuaValue {
    return this.#enter((L) => {
      const ex = this.runtime.exports
      ex.fl_pushglobaltable(L)
      this.push(L, name)
      ex.fl_rawget(L, -2)
      const value = this.read(L, -1)
      ex.fl_settop(L, -3)
      return value
    })
  }

  /** Sets a global without invoking metamethods. */
  setGlobal(name: string, value: LuaValue): void {
    this.#enter((L) => {
      const ex = this.runtime.exports
      ex.fl_pushglobaltable(L)
      this.push(L, name)
      this.push(L, value)
      ex.fl_rawset(L, -3)
      ex.fl_settop(L, -2)
    })
  }

  /** FiveM's require: returns loaded libraries and opens 'glm' on demand. */
  requireFunction(): LuaRef {
    return this.cFunction(CFunction.require)
  }

  /** C function `which` of the module (see CFunction), closing over `upvalues`. */
  cFunction(which: number, ...upvalues: LuaValue[]): LuaRef {
    return this.#enter((L) => {
      for (const value of upvalues) this.push(L, value)
      this.runtime.exports.fl_pushcfunction(L, which, upvalues.length)
      return this.#popRef(L)
    })
  }

  /** Exposes a JavaScript function to this state. Host functions live as long as the state. */
  hostFunction(fn: HostFunction): LuaHostFunction {
    this.#checkOpen()
    this.#functions.push(fn)
    return new LuaHostFunction(this, this.#functions.length - 1)
  }

  /**
   * Interrupts scripts that run too long without returning to JavaScript.
   * Applies to threads created after the call, so set it before running code.
   */
  setWatchdog(options: WatchdogOptions | null): void {
    this.#checkOpen()
    if (options === null) {
      this.#watchdog = undefined
      this.runtime.exports.fl_sethook(this.L, 0)
      return
    }
    const { timeoutMs, killAfterMs = timeoutMs * 2, interval = 1000 } = options
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      throw new RangeError(`Invalid watchdog timeout: ${timeoutMs}`)
    }
    if (!(killAfterMs >= timeoutMs)) {
      throw new RangeError(`The watchdog must stop a state after its timeout, not ${killAfterMs}`)
    }
    if (!Number.isInteger(interval) || interval < 1 || interval > 0x7fff_ffff) {
      throw new RangeError(`Invalid watchdog interval: ${interval}`)
    }
    this.#watchdog = { timeoutMs, killAfterMs, interval }
    this.runtime.exports.fl_sethook(this.L, interval)
  }

  /** Runs a full garbage collection cycle. */
  collectGarbage(): void {
    this.#enter((L) => {
      this.runtime.exports.fl_gc(L, LUA_GCCOLLECT, 0)
    })
  }

  /** Closes the state, running pending finalizers. A state that died is only discarded. */
  close(): void {
    if (this.#closed) return
    if (this.#entries > 0 || this.#threads.length > 0) {
      throw new Error('Cannot close a Lua state while it is running')
    }
    if (this.dead) {
      this.#closed = true
      this.runtime.forget(this.id)
      return
    }
    this.runtime.checkEnter()
    this.#closed = true
    // Finalizers may call host functions while the state closes.
    this.#sliceStart = performance.now()
    try {
      this.runtime.exports.fl_close(this.L)
    } catch (error) {
      throw this.runtime.escaped(error)
    } finally {
      this.runtime.forget(this.id)
    }
  }

  /** Pushes a JavaScript value onto the stack of thread L. */
  push(L: Ptr, value: LuaValue): void {
    const ex = this.runtime.exports
    switch (typeof value) {
      case 'undefined':
        ex.fl_pushnil(L)
        return
      case 'boolean':
        ex.fl_pushboolean(L, value ? 1 : 0)
        return
      case 'number':
        if (Number.isSafeInteger(value) && !Object.is(value, -0)) ex.fl_pushinteger(L, value)
        else ex.fl_pushnumber(L, value)
        return
      case 'bigint':
        ex.fl_pushinteger64(L, BigInt.asIntN(64, value))
        return
      case 'string':
        this.runtime.withString(value, (ptr, length) => ex.fl_pushlstring(L, ptr, length))
        return
      case 'object':
        if (value === null) {
          ex.fl_pushnil(L)
        } else if (value instanceof Uint8Array) {
          this.runtime.withBytes(value, (ptr, length) => ex.fl_pushlstring(L, ptr, length))
        } else if (value instanceof LuaFloat) {
          ex.fl_pushnumber(L, value.value)
        } else if (value instanceof LuaVector) {
          ex.fl_pushvector(L, VECTOR_KIND[value.type], value.x, value.y, value.z, value.w)
        } else if (value instanceof LuaRef) {
          if (value.state !== this) throw new TypeError('LuaRef belongs to another Lua state')
          if (value.ref < 0) throw new TypeError('LuaRef has been released')
          ex.fl_getref(L, value.ref)
        } else if (value instanceof LuaHostFunction) {
          if (value.state !== this) {
            throw new TypeError('Host function belongs to another Lua state')
          }
          ex.fl_pushhostfunction(L, value.id)
        } else {
          throw new TypeError(`Cannot pass ${Object.prototype.toString.call(value)} to Lua`)
        }
        return
      default:
        throw new TypeError(`Cannot pass a ${typeof value} to Lua`)
    }
  }

  /** Reads the value at `index` on thread L. */
  read(L: Ptr, index: number): LuaValue {
    const ex = this.runtime.exports
    const type = ex.fl_type(L, index)
    switch (type) {
      case LUA_TNONE:
      case LUA_TNIL:
        return null
      case LUA_TBOOLEAN:
        return ex.fl_toboolean(L, index) !== 0
      case LUA_TNUMBER: {
        const n = ex.fl_tonumber(L, index)
        if (ex.fl_isinteger(L, index) === 0 || Number.isSafeInteger(n)) return n
        return ex.fl_tointeger64(L, index)
      }
      case LUA_TSTRING: {
        const ptr = ex.fl_tolstring(L, index, this.runtime.out) >>> 0
        return this.runtime.readString(ptr, this.runtime.view.getUint32(this.runtime.out, true))
      }
      case LUA_TVECTOR: {
        const out = this.runtime.out
        const kind = ex.fl_tovector(L, index, out)
        const view = this.runtime.view
        // Components past a vector's size are unspecified, so only read the used ones.
        const size = kind === VECTOR_KIND.quat ? 4 : kind
        const component = (i: number) => (i < size ? view.getFloat32(out + i * 4, true) : 0)
        return new LuaVector(
          VECTOR_TYPES[kind] ?? 'vector4',
          component(0),
          component(1),
          component(2),
          component(3),
        )
      }
      default: {
        ex.fl_pushvalue(L, index)
        return this.#popRef(L, REF_TYPES[type] ?? 'userdata')
      }
    }
  }

  /** Reads a string at `index` as bytes. */
  readBytes(L: Ptr, index: number): Uint8Array {
    const ptr = this.runtime.exports.fl_tolstring(L, index, this.runtime.out) >>> 0
    return this.runtime.readBytes(ptr, this.runtime.view.getUint32(this.runtime.out, true))
  }

  /** Called by LuaRef.release. */
  unref(ref: LuaRef, value: number): void {
    this.#finalizer.unregister(ref)
    this.#release(value)
  }

  /**
   * Runs host function `fn` for the fivelab.call import. Only Lua errors and
   * fatal errors may leave it: any other exception would unwind Lua frames
   * without Lua noticing.
   */
  dispatch(L: Ptr, fn: number, nargs: number): number {
    if (this.#dead) throw this.#dead
    const host = this.#functions[fn]
    if (host === undefined) throw this.runtime.crash(new Error(`Unknown host function ${fn}`))
    this.#threads.push(L)
    try {
      const result = host(new HostArgs(this, L, nargs))
      this.#throwIfDead()
      if (result === undefined) return 0
      if (Array.isArray(result)) {
        for (const value of result as readonly LuaValue[]) this.push(L, value)
        return result.length
      }
      this.push(L, result as LuaValue)
      return 1
    } catch (error) {
      // A Lua error raised by a nested call unwinds to its Lua frame.
      if (error instanceof WebAssembly.Exception) throw error
      this.#throwIfDead()
      if (error instanceof WebAssembly.RuntimeError || isStackOverflow(error)) {
        throw this.runtime.crash(error)
      }
      this.#pushInLua(L, errorMessage(error))
      if (error instanceof LuaArgumentError) {
        this.#pushInLua(L, error.argument)
        return -2
      }
      return error instanceof LuaCallerError ? -3 : -1
    } finally {
      this.#threads.pop()
    }
  }

  /** Runs the watchdog for the fivelab.hook import. */
  hook(L: Ptr): number {
    if (this.#dead) throw this.#dead
    const watchdog = this.#watchdog
    if (watchdog === undefined) return 0
    const elapsed = performance.now() - this.#sliceStart
    if (elapsed < watchdog.timeoutMs) return 0
    if (elapsed >= watchdog.killAfterMs) {
      throw this.#die(
        `Lua state stopped: a script kept running for ${Math.round(elapsed)} ms after the watchdog raised an error`,
      )
    }
    this.#pushInLua(
      L,
      `script ran for more than ${watchdog.timeoutMs} ms without yielding (missing Wait in a loop?)`,
    )
    return 1
  }

  /** Handles the fivelab.panic import; returns the error to throw. */
  panic(L: Ptr): LuaFatalError {
    const ex = this.runtime.exports
    let message = 'error object is not a string'
    if (ex.fl_type(L, -1) === LUA_TSTRING) {
      const ptr = ex.fl_tolstring(L, -1, this.runtime.out) >>> 0
      message = this.runtime.readString(ptr, this.runtime.view.getUint32(this.runtime.out, true))
    }
    return this.#die(`PANIC: unprotected error in call to Lua API (${message})`)
  }

  /** Handles the fivelab.warn import: joins the pieces of a warning and reports it. */
  warn(piece: Uint8Array, more: boolean): void {
    this.#warning += this.#warningDecoder.decode(piece, { stream: more })
    if (more) return
    const message = this.#warning
    this.#warning = ''
    const onWarning = this.#onWarning
    if (onWarning === undefined) this.runtime.write('stderr', `Lua warning: ${message}\n`)
    else this.runtime.notify(() => onWarning(message))
  }

  #die(message: string): LuaFatalError {
    this.#dead ??= new LuaFatalError(message, 'state')
    return this.#dead
  }

  #throwIfDead(): void {
    const dead = this.dead
    if (dead) throw dead
  }

  #checkOpen(): void {
    this.#throwIfDead()
    if (this.#closed) throw new Error('Lua state is closed')
  }

  /** Pushes inside a host call or hook, where only Lua errors may unwind; anything else crashes. */
  #pushInLua(L: Ptr, value: LuaValue): void {
    try {
      this.push(L, value)
    } catch (error) {
      if (error instanceof WebAssembly.Exception) throw error
      throw this.runtime.crash(error)
    }
  }

  /**
   * Runs `body` against `thread`, by default the current thread: the one that
   * made the innermost active host call, or the main thread. Restores the
   * stack if JavaScript throws midway, and translates exceptions that escaped
   * the module.
   */
  #enter<T>(body: (L: Ptr) => T, thread?: Ptr): T {
    this.#checkOpen()
    this.runtime.checkEnter()
    if (nestedCalls >= MAX_NESTED_CALLS) {
      throw new RangeError(`Too many nested calls between JavaScript and Lua (${MAX_NESTED_CALLS})`)
    }
    const L = thread ?? this.#threads.at(-1) ?? this.L
    const ex = this.runtime.exports
    const top = ex.fl_gettop(L)
    if (this.#entries === 0) this.#sliceStart = performance.now()
    this.#entries++
    nestedCalls++
    try {
      return body(L)
    } catch (error) {
      const escaped = this.runtime.escaped(error)
      if (
        escaped === error &&
        !(error instanceof WebAssembly.Exception) &&
        !(error instanceof LuaFatalError)
      ) {
        ex.fl_settop(L, top)
      }
      throw escaped
    } finally {
      nestedCalls--
      this.#entries--
    }
  }

  /** Pops the value on top into the registry. */
  #popRef(L: Ptr, type?: LuaRefType): LuaRef {
    const ex = this.runtime.exports
    const refType = type ?? REF_TYPES[ex.fl_type(L, -1)] ?? 'userdata'
    const ref = new LuaRef(this, ex.fl_ref(L), refType)
    this.#finalizer.register(ref, ref.ref, ref)
    return ref
  }

  /** Pops the error object of a failed call above `base` into a LuaError. */
  #popError(L: Ptr, status: number, base: number, traceback: boolean): LuaError {
    const ex = this.runtime.exports
    const runtime = this.runtime
    if (ex.fl_type(L, -1) !== LUA_TSTRING && ex.fl_type(L, -1) !== LUA_TNUMBER) {
      ex.fl_tostring(L, -1)
    }
    const messagePtr = ex.fl_tolstring(L, -1, runtime.out) >>> 0
    const message = runtime.readString(messagePtr, runtime.view.getUint32(runtime.out, true))
    let luaTraceback: string | undefined
    if (traceback) {
      const ptr = ex.fl_traceback(L, runtime.out) >>> 0
      if (ptr !== 0) {
        luaTraceback = runtime.readString(ptr, runtime.view.getUint32(runtime.out, true))
      }
    }
    ex.fl_settop(L, base)
    return new LuaError(message, LuaError.kindOf(status), luaTraceback)
  }

  #release(ref: number): void {
    if (this.#closed || this.dead) return
    this.runtime.exports.fl_unref(this.#threads.at(-1) ?? this.L, ref)
  }
}
