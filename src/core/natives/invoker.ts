import {
  ARG_POINTER,
  ARG_SIZE,
  ARG_STRING,
  ArgSource,
  MetaField,
  NATIVE_ARGS,
  NativeCallLayout as Layout,
} from '../lua/abi.ts'
import { LuaFatalError, LuaFloat, LuaVector, type LuaRuntime, type LuaValue } from '../lua/index.ts'
import {
  typeInfo,
  type NativePointer,
  type ParamType,
  type ResultType,
  type TypeInfo,
  type Vector3Like,
} from './types.ts'

/**
 * Thrown by a native implementation to fail the call. The script gets the
 * error the way FiveM reports a failing native: "native <hash>: <message>".
 */
export class NativeError extends Error {
  override readonly name = 'NativeError'
}

/** What the invoker needs from the script that calls a native. */
export interface NativeCaller {
  /** The Lua runtime whose memory holds the marshalled call. */
  readonly lua: LuaRuntime
  /** Converts the bytes of an object result with the script's deserializer (msgpack.unpack). */
  deserialize(bytes: Uint8Array): LuaValue
  /** Writes to the console as FiveM's scripting core does when a native fails. */
  trace(text: string): void
  /** Reports a mistake in how the script uses a native. */
  diagnose(message: string): void
  /** Learns that the script called a native that FiveLab knows but does not implement. */
  unimplemented(name: string, hash: bigint): void
}

/** A native as the invoker runs it. */
export interface NativeDeclaration<Ctx> {
  /**
   * The name to report the native by: the name it is declared with, such as
   * GET_ENTITY_COORDS, or for natives of the catalog the name Lua calls it by.
   */
  readonly name: string
  readonly hash: bigint
  readonly result: ResultType
  /**
   * The type of the result that FiveM's implementation sets, where it is not
   * the declared one. The result is set as this type, then checked and read
   * as the declared one, as it is in FiveM.
   */
  readonly sets?: ResultType
  readonly params: readonly { readonly name: string; readonly type: ParamType }[]
  /** Runs the native; null for natives FiveLab knows but does not implement. */
  readonly impl: ((ctx: Ctx, ...args: never[]) => unknown) | null
}

/** How FiveM classifies results for its checks (PAS_RET_* in ScriptInvoker.cpp). */
const ResultClass = {
  void: 0,
  int: 1,
  float: 2,
  long: 3,
  vector3: 4,
  string: 5,
  object: 7,
} as const
type ResultClass = (typeof ResultClass)[keyof typeof ResultClass]

/** What a native expects in one argument slot, for FiveM's argument checks. */
interface SlotCheck {
  readonly pointer: boolean
  readonly string: boolean
  /** A read-only buffer whose length is the next argument. */
  readonly buffer: boolean
  /** The smallest buffer a pointer may point to. */
  readonly size: number
}

/** FiveM's type information for a native, which it derives from the declaration. */
interface TypeChecks {
  readonly slots: readonly SlotCheck[]
  /** No argument is a pointer, so calls without pointers skip the checks. */
  readonly trivial: boolean
  /** An argument is declared Any, so FiveM trusts none of the declared types. */
  readonly unsafe: boolean
  readonly result: ResultClass
}

/** A native ready to invoke. */
export interface PreparedNative<Ctx> extends NativeDeclaration<Ctx> {
  readonly paramTypes: readonly TypeInfo[]
  readonly checks: TypeChecks
}

const VALUE_SLOT: SlotCheck = { pointer: false, string: false, buffer: false, size: 0 }
const STRING_SLOT: SlotCheck = { pointer: true, string: true, buffer: false, size: 0 }
const BUFFER_SLOT: SlotCheck = { pointer: true, string: false, buffer: true, size: 0 }

function resultClass(result: ResultType): ResultClass {
  if (result === 'void') return ResultClass.void
  if (result === 'Any*') return ResultClass.long
  switch (typeInfo(result).kind) {
    case 'int':
    case 'bool':
      return ResultClass.int
    case 'long':
      return ResultClass.long
    case 'float':
      return ResultClass.float
    case 'vector3':
      return ResultClass.vector3
    case 'object':
      return ResultClass.object
    default:
      return ResultClass.string
  }
}

/** Derives what the invoker needs from a declaration, as codegen_out_pointer_args.lua does for FiveM. */
export function prepareNative<Ctx>(native: NativeDeclaration<Ctx>): PreparedNative<Ctx> {
  const paramTypes = native.params.map((param) => typeInfo(param.type))
  const slots: SlotCheck[] = []
  for (const info of paramTypes) {
    if (info.pointer) {
      const size = info.name === 'Any*' ? 0 : info.kind === 'vector3' ? 24 : 4
      slots.push({ pointer: true, string: false, buffer: false, size })
    } else if (info.kind === 'object') {
      slots.push(BUFFER_SLOT, VALUE_SLOT)
    } else if (info.kind === 'buffer') {
      slots.push(BUFFER_SLOT)
    } else if (info.kind === 'string' || info.kind === 'func') {
      slots.push(STRING_SLOT)
    } else {
      for (let i = info.kind === 'vector3' ? 3 : 1; i > 0; i--) slots.push(VALUE_SLOT)
    }
  }
  const unsafe = paramTypes.some((info) => info.name === 'Any')
  return {
    ...native,
    paramTypes,
    checks: {
      slots,
      trivial: !unsafe && slots.every((slot) => !slot.pointer),
      unsafe,
      result: resultClass(native.result),
    },
  }
}

/** What a non-NULL string or object result leaves in the result slot, as its pointer. */
const RESULT_POINTER = 0x10

/** FiveM's replacement for values that must not reach a native as pointers. */
const POISON_HIGH = 0xdead_beef
const POISON_LOW = 0x7fed_cafe

/** FiveM's limits on pointers it copies to isolated buffers. */
const MAX_ISOLATED_POINTERS = 8
const ISOLATED_BUFFER_SIZE = 7 * 4096

const decoder = new TextDecoder()

const bits = new DataView(new ArrayBuffer(4))

function floatFromBits(word: number): number {
  bits.setUint32(0, word)
  return bits.getFloat32(0)
}

function bitsFromFloat(value: number): number {
  bits.setFloat32(0, value)
  return bits.getUint32(0)
}

function int64(low: number, high: number): number | bigint {
  if ((high === 0 && low >= 0) || (high === 0xffff_ffff && low >= 0x8000_0000)) {
    return high === 0 ? low : low - 2 ** 32
  }
  const value = (BigInt(high | 0) << 32n) | BigInt(low >>> 0)
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value
}

function uint64(low: number, high: number): bigint {
  return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)
}

function splitInt64(value: number | bigint): [number, number] {
  if (typeof value === 'bigint') {
    const unsigned = BigInt.asUintN(64, value)
    return [Number(unsigned & 0xffff_ffffn), Number(unsigned >> 32n)]
  }
  if (!Number.isFinite(value)) return [0, 0]
  const whole = Math.trunc(value)
  return [whole >>> 0, Math.floor(whole / 2 ** 32) >>> 0]
}

/** How a FiveLab message shows a float the way Lua would print it. */
function formatFloat(value: number): string {
  if (Object.is(value, -0)) return '-0.0'
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`
  return String(Number(value.toPrecision(7)))
}

function readCString(lua: LuaRuntime, address: number, limit: number): string {
  const heap = lua.heap
  let end = address
  while (end < address + limit && heap[end] !== 0) end++
  return decoder.decode(heap.subarray(address, end))
}

/**
 * A marshalled call while it runs: the argument slots, copied out of module
 * memory so that checks can change them, and the primary result, which
 * stays in JavaScript.
 */
class Invocation {
  readonly lua: LuaRuntime
  readonly ptr: number
  readonly hash: bigint
  nargs: number
  /** Low and high word of each argument slot. */
  readonly args = new Uint32Array(NATIVE_ARGS * 2)
  readonly types = new Uint32Array(NATIVE_ARGS)
  readonly sources = new Uint8Array(NATIVE_ARGS)
  /** The primary result: four slots, low and high word of each. */
  readonly results = new Uint32Array(8)
  /** The string or bytes a pointer result points to. */
  resultData: string | Uint8Array | null = null

  constructor(lua: LuaRuntime, ptr: number) {
    this.lua = lua
    this.ptr = ptr
    const view = lua.view
    this.hash = uint64(
      view.getUint32(ptr + Layout.hash, true),
      view.getUint32(ptr + Layout.hash + 4, true),
    )
    this.nargs = view.getUint32(ptr + Layout.nargs, true)
    for (let i = 0; i < this.nargs; i++) {
      this.args[i * 2] = view.getUint32(ptr + Layout.arguments + i * 8, true)
      this.args[i * 2 + 1] = view.getUint32(ptr + Layout.arguments + i * 8 + 4, true)
      this.types[i] = view.getUint32(ptr + Layout.types + i * 4, true)
      this.sources[i] = view.getUint8(ptr + Layout.sources + i)
    }
  }

  /** How the script asked to read the primary result (a MetaField). */
  get primaryType(): number {
    return this.lua.view.getUint8(this.ptr + Layout.rettypes)
  }

  isPointer(slot: number): boolean {
    return (this.types[slot]! & ARG_POINTER) !== 0
  }

  isZero(slot: number): boolean {
    return this.args[slot * 2] === 0 && this.args[slot * 2 + 1] === 0
  }

  /** Fails the call as FiveM's ScriptNativeContext::ScriptError does. */
  fail(caller: NativeCaller, message: string): never {
    const text = `native ${this.hash.toString(16).padStart(16, '0')}: ${message}`
    caller.trace(`script error in ${text}\n`)
    throw new NativeFailure(text)
  }
}

/** Ends a call with the error the script gets; see Invocation.fail. */
class NativeFailure extends Error {
  override readonly name = 'NativeFailure'
}

/**
 * FiveM's argument checks (ScriptNativeContext::CheckArguments). With type
 * information, missing arguments become 0, a pointer where a value belongs
 * becomes a poison value, and a value or a non-string where a pointer or a
 * string belongs fails the call. Arguments past the declared ones, all of them
 * for unknown natives, have their upper half poisoned so they never work as
 * pointers.
 */
function checkArguments(call: Invocation, caller: NativeCaller, checks: TypeChecks | null): void {
  let isolated = 0
  let isolatedBytes = 0
  const isolate = (slot: number) => {
    if (call.sources[slot] === ArgSource.pointer) return // out-pointers are isolated already
    if (isolated >= MAX_ISOLATED_POINTERS) call.fail(caller, 'too many unknown pointers')
    isolated++
    const type = call.types[slot]!
    isolatedBytes += ((type & ARG_SIZE) + ((type & ARG_STRING) !== 0 ? 1 : 0) + 7) & ~7
    if (isolatedBytes > ISOLATED_BUFFER_SIZE) call.fail(caller, 'too much isolated data')
  }
  let expected = 0
  let valid = 0
  if (checks !== null) {
    expected = checks.slots.length
    if (checks.trivial) {
      let pointers = false
      for (let i = 0; i < call.nargs; i++) if (call.isPointer(i)) pointers = true
      if (!pointers) {
        if (call.nargs === expected) return
        valid = expected
      }
    }
    // Arguments a script leaves out read as 0, as FiveM fills them in.
    for (let i = call.nargs; i < expected; i++) {
      call.args[i * 2] = 0
      call.args[i * 2 + 1] = 0
      call.types[i] = 0
      call.sources[i] = ArgSource.nil
    }
    call.nargs = Math.max(call.nargs, expected)
    if (checks.unsafe) {
      expected = 0
      valid = 0
    }
  }
  for (let i = valid; i < expected; i++) {
    const check = checks!.slots[i]!
    if (!check.pointer) {
      if (call.isPointer(i) && !call.isZero(i)) {
        call.args[i * 2] = POISON_LOW
        call.args[i * 2 + 1] = POISON_HIGH
        call.types[i] = 0
        call.sources[i] = ArgSource.integer
      }
      continue
    }
    if (!call.isPointer(i)) {
      if (!call.isZero(i)) call.fail(caller, `arg[${i}]: expected pointer, got non-zero integer`)
      continue
    }
    if (check.string) {
      if ((call.types[i]! & ARG_STRING) === 0) call.fail(caller, `arg[${i}]: expected string`)
      continue
    }
    const size = call.types[i]! & ARG_SIZE
    if (size < check.size)
      call.fail(caller, `arg[${i}]: buffer too small (${size} < ${check.size})`)
    if (check.buffer) {
      const length = uint64(call.args[(i + 1) * 2]!, call.args[(i + 1) * 2 + 1]!)
      if (length > BigInt(size))
        call.fail(caller, `arg[${i}]: buffer length too large (${length} > ${size})`)
      continue
    }
    isolate(i)
  }
  for (let i = expected; i < call.nargs; i++) {
    if (call.isPointer(i)) isolate(i)
    else if (!call.isZero(i)) call.args[i * 2 + 1] = POISON_HIGH
  }
}

/** A pointer argument: an out-pointer buffer in module memory, read-only string memory, or NULL. */
class Pointer<T> implements NativePointer<T> {
  readonly #lua: LuaRuntime
  readonly #address: number
  readonly #writable: boolean
  readonly #info: TypeInfo

  constructor(lua: LuaRuntime, address: number, writable: boolean, info: TypeInfo) {
    this.#lua = lua
    this.#address = address
    this.#writable = writable
    this.#info = info
  }

  get valid(): boolean {
    return this.#address !== 0
  }

  get(): T {
    const at = this.#address
    const kind = this.#info.kind
    if (at === 0) {
      if (kind === 'vector3') return new LuaVector('vector3', 0, 0, 0) as T
      return (kind === 'bool' ? false : 0) as T
    }
    const view = this.#lua.view
    switch (kind) {
      case 'float':
        return view.getFloat32(at, true) as T
      case 'long':
        return int64(view.getUint32(at, true), view.getUint32(at + 4, true)) as T
      case 'vector3':
        return new LuaVector(
          'vector3',
          view.getFloat32(at, true),
          view.getFloat32(at + 8, true),
          view.getFloat32(at + 16, true),
        ) as T
      case 'bool':
        return (
          this.#info.name === 'bool*' ? view.getUint8(at) !== 0 : view.getInt32(at, true) !== 0
        ) as T
      default:
        return (this.#info.unsigned ? view.getUint32(at, true) : view.getInt32(at, true)) as T
    }
  }

  set(value: T): void {
    const at = this.#address
    if (at === 0 || !this.#writable) return
    const view = this.#lua.view
    switch (this.#info.kind) {
      case 'float':
        view.setFloat32(at, Number(value), true)
        return
      case 'long': {
        const [low, high] = splitInt64(value as number | bigint)
        view.setUint32(at, low, true)
        view.setUint32(at + 4, high, true)
        return
      }
      case 'vector3': {
        const vector = value as Vector3Like
        view.setFloat32(at, vector.x, true)
        view.setFloat32(at + 8, vector.y, true)
        view.setFloat32(at + 16, vector.z, true)
        return
      }
      case 'bool':
        if (this.#info.name === 'bool*') view.setUint8(at, value ? 1 : 0)
        else view.setInt32(at, value ? 1 : 0, true)
        return
      default:
        view.setUint32(at, Number(value) >>> 0, true)
    }
  }
}

/** Reads the arguments a native declares from their slots, and reports likely mistakes. */
function decodeArguments<Ctx>(
  call: Invocation,
  caller: NativeCaller,
  native: PreparedNative<Ctx>,
): unknown[] {
  const values: unknown[] = []
  const lua = call.lua
  let slot = 0
  for (let p = 0; p < native.paramTypes.length; p++) {
    const info = native.paramTypes[p]!
    const low = call.args[slot * 2]!
    const high = call.args[slot * 2 + 1]!
    const source = call.sources[slot]
    const param = () => `${native.name}: argument ${p + 1} (${native.params[p]!.name})`
    if (info.pointer) {
      const pointer = call.isPointer(slot)
      values.push(
        new Pointer(lua, pointer ? low : 0, pointer && source === ArgSource.pointer, info),
      )
      slot++
      continue
    }
    switch (info.kind) {
      case 'int': {
        const value = info.unsigned ? low >>> 0 : low | 0
        if (source === ArgSource.float && low !== 0) {
          caller.diagnose(
            `${param()} is an integer, but the script passed the float ${formatFloat(floatFromBits(low))}, ` +
              `which FiveM reads as ${value}. Pass an integer instead.`,
          )
        }
        values.push(value)
        slot++
        break
      }
      case 'long':
        values.push(int64(low, high))
        slot++
        break
      case 'float': {
        const value = floatFromBits(low)
        if (source === ArgSource.integer && (low !== 0 || high !== 0)) {
          const passed = String(int64(low, high))
          caller.diagnose(
            `${param()} is a float, but the script passed the integer ${passed}, ` +
              `which FiveM reads as ${formatFloat(value)}. Write ${passed}.0 instead.`,
          )
        } else if (source === ArgSource.boolean && low !== 0) {
          caller.diagnose(
            `${param()} is a float, but the script passed true, which FiveM reads as ${formatFloat(value)}.`,
          )
        }
        values.push(value)
        slot++
        break
      }
      case 'bool':
        values.push(info.name === 'bool' ? (low & 0xff) !== 0 : low !== 0)
        slot++
        break
      case 'string':
      case 'func':
        values.push(
          call.isPointer(slot) ? readCString(lua, low, call.types[slot]! & ARG_SIZE) : null,
        )
        slot++
        break
      case 'buffer':
      case 'object': {
        const next = slot + 1
        const length = Math.min(
          Number(uint64(call.args[next * 2]!, call.args[next * 2 + 1]!) & 0xffff_ffffn),
          call.types[slot]! & ARG_SIZE,
        )
        if (!call.isPointer(slot)) values.push(info.kind === 'buffer' ? null : new Uint8Array(0))
        else values.push(lua.heap.slice(low, low + length))
        slot += info.kind === 'object' ? 2 : 1
        break
      }
      case 'vector3':
        values.push(
          new LuaVector(
            'vector3',
            floatFromBits(low),
            floatFromBits(call.args[(slot + 1) * 2]!),
            floatFromBits(call.args[(slot + 2) * 2]!),
          ),
        )
        slot += 3
        break
    }
  }
  return values
}

/** Stores what an implementation returned in the primary result, as a native writes it. */
function encodeResult(call: Invocation, result: ResultType, value: unknown): void {
  if (result === 'void' || value === undefined) return
  const slots = call.results
  const kind = result === 'Any*' ? 'long' : typeInfo(result).kind
  switch (kind) {
    case 'int':
      slots[0] = Number(value) >>> 0
      return
    case 'long': {
      const [low, high] = splitInt64(value as number | bigint)
      slots[0] = low
      slots[1] = high
      return
    }
    case 'bool':
      slots[0] = value ? 1 : 0
      return
    case 'float':
      slots[0] = bitsFromFloat(Number(value))
      return
    case 'vector3': {
      const vector = value as Vector3Like
      slots[0] = bitsFromFloat(vector.x)
      slots[2] = bitsFromFloat(vector.y)
      slots[4] = bitsFromFloat(vector.z)
      return
    }
    default:
      if (value === null) return
      call.resultData = value as string | Uint8Array
      slots[0] = RESULT_POINTER
  }
}

/**
 * FiveM's result checks (ScriptNativeContext::CheckResults): scripts may only
 * read a string, vector or object from natives that return one, and reading
 * a number from any other kind of result gives a poison value unless it is 0.
 */
function checkResults(call: Invocation, caller: NativeCaller, result: ResultClass | null): void {
  const type = call.primaryType
  if (result === null) {
    if (type === MetaField.resultAsLong) call.results[1] = 0
    else if (type === MetaField.resultAsObject) {
      call.fail(caller, 'undocumented natives cannot return an object')
    }
    return
  }
  switch (type) {
    case MetaField.resultAsString:
      if (result !== ResultClass.string) call.fail(caller, 'result type is not a string')
      return
    case MetaField.resultAsVector:
      if (result !== ResultClass.vector3) call.fail(caller, 'result type is not a vector')
      return
    case MetaField.resultAsObject:
      if (result !== ResultClass.object) call.fail(caller, 'result type is not an object')
      return
    default:
      if (
        result !== ResultClass.int &&
        result !== ResultClass.float &&
        result !== ResultClass.long &&
        (call.results[0] !== 0 || call.results[1] !== 0)
      ) {
        call.results[0] = POISON_LOW
        call.results[1] = POISON_HIGH
      }
  }
}

/** Reads one result the way the script asked for it (ScriptNativeContext::ProcessResult). */
function readResult(call: Invocation, caller: NativeCaller, index: number, type: number): LuaValue {
  let word: (i: number) => number
  if (index === 0) {
    word = (i) => call.results[i]!
  } else {
    const view = call.lua.view
    const at = view.getUint32(call.ptr + Layout.retvals + index * 4, true)
    word = (i) => view.getUint32(at + i * 4, true)
  }
  switch (type) {
    case MetaField.resultAsString: {
      const data = index === 0 ? call.resultData : null
      if (data === null || word(0) === 0) return null
      if (data instanceof Uint8Array) return data
      const end = data.indexOf('\0')
      return end < 0 ? data : data.slice(0, end)
    }
    case MetaField.resultAsFloat:
    case MetaField.pointerValueFloat:
      return new LuaFloat(floatFromBits(word(0)))
    case MetaField.resultAsVector:
    case MetaField.pointerValueVector:
      return new LuaVector(
        'vector3',
        floatFromBits(word(0)),
        floatFromBits(word(2)),
        floatFromBits(word(4)),
      )
    case MetaField.resultAsObject: {
      const data = index === 0 ? call.resultData : null
      return caller.deserialize(
        data instanceof Uint8Array && word(0) !== 0 ? data : new Uint8Array(0),
      )
    }
    case MetaField.resultAsInteger:
    case MetaField.pointerValueInt:
      return word(0) | 0
    case MetaField.resultAsLong:
      return int64(word(0), word(1))
    default: {
      const integer = word(0) | 0
      return integer === 0 ? false : integer
    }
  }
}

/** The primary result unless the script only asked for out-pointers, then each out-pointer. */
function processResults(call: Invocation, caller: NativeCaller): LuaValue[] {
  const view = call.lua.view
  const count = view.getUint32(call.ptr + Layout.nretvals, true)
  const values: LuaValue[] = []
  for (let i = count === 1 || call.primaryType !== MetaField.none ? 0 : 1; i < count; i++) {
    values.push(readResult(call, caller, i, view.getUint8(call.ptr + Layout.rettypes + i)))
  }
  return values
}

/**
 * Runs the call cfxlua.wasm marshalled at `ptr` (Citizen.InvokeNative in
 * native/fivelab.cpp) and returns what the script gets back. `native` is
 * undefined for a hash no native has: FiveM runs those as natives that do
 * nothing, without type information. Natives without an implementation do
 * nothing too, after the checks their types call for.
 *
 * A call that fails returns its error and marks the call failed, for
 * cfxlua.wasm to raise the error from the native's own function.
 */
export function invokeNative<Ctx extends NativeCaller>(
  ctx: Ctx,
  ptr: number,
  native: (hash: bigint) => PreparedNative<Ctx> | undefined,
): LuaValue[] {
  const lua = ctx.lua
  const call = new Invocation(lua, ptr)
  try {
    const error = lua.view.getUint32(ptr + Layout.error, true)
    if (error !== 0) call.fail(ctx, readCString(lua, error, 256))
    const found = native(call.hash)
    checkArguments(call, ctx, found?.checks ?? null)
    if (found?.impl === null) ctx.unimplemented(found.name, found.hash)
    if (found?.impl) {
      const args = decodeArguments(call, ctx, found)
      let result: unknown
      try {
        result = (found.impl as (ctx: Ctx, ...args: unknown[]) => unknown)(ctx, ...args)
      } catch (thrown) {
        if (thrown instanceof WebAssembly.Exception || thrown instanceof LuaFatalError) throw thrown
        call.fail(ctx, thrown instanceof Error ? thrown.message : String(thrown))
      }
      encodeResult(call, found.sets ?? found.result, result)
    }
    checkResults(call, ctx, found?.checks.result ?? null)
    return processResults(call, ctx)
  } catch (failure) {
    if (!(failure instanceof NativeFailure)) throw failure
    lua.view.setUint32(ptr + Layout.failed, 1, true)
    return [failure.message]
  }
}
