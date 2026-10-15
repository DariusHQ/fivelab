/**
 * The C ABI of cfxlua.wasm, defined in native/fiverunner.cpp. Pointers are
 * offsets into the module's linear memory.
 */

export type Ptr = number

export interface CfxLuaExports {
  readonly memory: WebAssembly.Memory
  _initialize(): void
  malloc(size: number): Ptr
  free(ptr: Ptr): void

  fr_newstate(vm: number): Ptr
  fr_close(L: Ptr): void
  fr_openlibs(L: Ptr, mask: number): number
  fr_memused(L: Ptr): number
  fr_getmemlimit(L: Ptr): number
  fr_setmemlimit(L: Ptr, limit: number): void
  fr_gc(L: Ptr, what: number, arg: number): number
  fr_sethook(L: Ptr, count: number): void
  fr_stacksave(): Ptr
  fr_stackrestore(sp: Ptr): void

  fr_gettop(L: Ptr): number
  fr_settop(L: Ptr, idx: number): void
  fr_pushvalue(L: Ptr, idx: number): void
  fr_type(L: Ptr, idx: number): number

  fr_pushnil(L: Ptr): void
  fr_pushboolean(L: Ptr, b: number): void
  fr_pushinteger(L: Ptr, n: number): void
  fr_pushinteger64(L: Ptr, n: bigint): void
  fr_pushnumber(L: Ptr, n: number): void
  fr_pushlstring(L: Ptr, s: Ptr, len: number): void
  fr_pushvector(L: Ptr, kind: number, x: number, y: number, z: number, w: number): void
  fr_pushhostfunction(L: Ptr, fn: number): void
  fr_pushcfunction(L: Ptr, which: number, nup: number): void
  fr_pushglobaltable(L: Ptr): void

  fr_toboolean(L: Ptr, idx: number): number
  fr_tonumber(L: Ptr, idx: number): number
  fr_tointeger64(L: Ptr, idx: number): bigint
  fr_isinteger(L: Ptr, idx: number): number
  fr_isintegral(L: Ptr, idx: number): number
  fr_isnumber(L: Ptr, idx: number): number
  fr_tolstring(L: Ptr, idx: number, len: Ptr): Ptr
  fr_tovector(L: Ptr, idx: number, out: Ptr): number
  fr_tostring(L: Ptr, idx: number): number

  fr_rawget(L: Ptr, idx: number): number
  fr_rawset(L: Ptr, idx: number): void
  fr_gettable(L: Ptr, idx: number): number
  fr_createtable(L: Ptr, narr: number, nrec: number): void
  fr_setlib(L: Ptr): void
  fr_ref(L: Ptr): number
  fr_unref(L: Ptr, ref: number): void
  fr_getref(L: Ptr, ref: number): number

  fr_load(L: Ptr, buf: Ptr, len: number, name: Ptr, mode: Ptr): number
  fr_pcall(L: Ptr, nargs: number, nresults: number): number
  fr_traceback(L: Ptr, len: Ptr): Ptr
}

/** Functions the module imports from the "fiverunner" namespace. */
export interface CfxLuaHostImports {
  call(vm: number, L: Ptr, fn: number, nargs: number): number
  hook(vm: number, L: Ptr): number
  panic(vm: number, L: Ptr): void
  warn(vm: number, msg: Ptr, len: number, tocont: number): void
}

export const LUA_OK = 0
export const LUA_YIELD = 1
export const LUA_ERRRUN = 2
export const LUA_ERRSYNTAX = 3
export const LUA_ERRMEM = 4
export const LUA_ERRERR = 5

export const LUA_MULTRET = -1

export const LUA_TNONE = -1
export const LUA_TNIL = 0
export const LUA_TBOOLEAN = 1
export const LUA_TLIGHTUSERDATA = 2
export const LUA_TNUMBER = 3
export const LUA_TVECTOR = 4
export const LUA_TSTRING = 5
export const LUA_TTABLE = 6
export const LUA_TFUNCTION = 7
export const LUA_TUSERDATA = 8
export const LUA_TTHREAD = 9
export const LUA_TMATRIX = 10

export const LUA_GCCOLLECT = 2

/** Library bits for fr_openlibs, in the order FiveM opens them. */
export const LuaLib = {
  base: 1 << 0,
  table: 1 << 1,
  string: 1 << 2,
  math: 1 << 3,
  coroutine: 1 << 4,
  utf8: 1 << 5,
  debug: 1 << 6,
  msgpack: 1 << 7,
  json: 1 << 8,
  glm: 1 << 9,
} as const

/** The libraries every FiveM Lua runtime opens. glm loads through require. */
export const FIVEM_LIBS =
  LuaLib.base |
  LuaLib.table |
  LuaLib.string |
  LuaLib.math |
  LuaLib.coroutine |
  LuaLib.utf8 |
  LuaLib.debug |
  LuaLib.msgpack |
  LuaLib.json

/** C functions fr_pushcfunction can push, after the upvalues they take. */
export const CFunction = {
  require: 1,
  /** Citizen.InvokeNative. Upvalue: the invoker host function. */
  invokeNative: 2,
  /** Citizen.GetNative. Upvalue: the invoker host function. */
  getNative: 3,
  /** Citizen.InvokeNative2. Upvalue: the invoker host function. */
  invokeNative2: 4,
  pointerValueInt: 5,
  pointerValueFloat: 6,
  pointerValueVector: 7,
  returnResultAnyway: 8,
  resultAsInteger: 9,
  resultAsLong: 10,
  resultAsFloat: 11,
  resultAsString: 12,
  resultAsVector: 13,
  /** The marker that Citizen.ResultAsObject2 returns. */
  resultAsObject: 14,
  pointerValueIntInitialized: 15,
  pointerValueFloatInitialized: 16,
  awaitSentinel: 17,
  noop: 18,
  /** FiveM's print. Upvalue: a function that writes text to the console. */
  print: 19,
  /** Citizen.Trace. Upvalue: a function that writes text to the console. */
  trace: 20,
  /**
   * checked(checks, fn) returns fn behind a C function that checks its
   * arguments as FiveM's C functions do, one character of `checks` for each:
   * 's' a string, 'n' a number, 'i' an integer, '.' any value. They run
   * from the first argument to the last, or after a leading '<' from the
   * last to the first.
   */
  checked: 21,
} as const

/** How to read a native result, in the order of FiveM's fx::invoker::MetaField. */
export const MetaField = {
  pointerValueInt: 0,
  pointerValueFloat: 1,
  pointerValueVector: 2,
  returnResultAnyway: 3,
  resultAsInteger: 4,
  resultAsLong: 5,
  resultAsFloat: 6,
  resultAsString: 7,
  resultAsVector: 8,
  resultAsObject: 9,
  /** No marker chose: read the primary result as FiveM does by default. */
  none: 10,
} as const

/**
 * Offsets in FRNativeCall, the marshalled native call that
 * native/fiverunner.cpp hands to the invoker.
 */
export const NativeCallLayout = {
  hash: 0,
  arguments: 8,
  results: 264,
  types: 680,
  retvals: 808,
  rettypes: 872,
  sources: 888,
  nargs: 920,
  nretvals: 924,
  error: 932,
  failed: 936,
} as const

/** Native argument slots and out-pointer results a call can hold. */
export const NATIVE_ARGS = 32
export const NATIVE_RETVALS = 16

/** Bits of an argument's type word. The rest is the size of what a pointer points to. */
export const ARG_POINTER = 0x8000_0000
export const ARG_STRING = 0x4000_0000
export const ARG_SIZE = 0x1fff_ffff

/** The kind of Lua value an argument slot came from. */
export const ArgSource = {
  nil: 0,
  boolean: 1,
  integer: 2,
  float: 3,
  string: 4,
  vector: 5,
  pointer: 6,
} as const

/** Vector kinds used by fr_pushvector and fr_tovector. */
export const VECTOR_KIND = { vector2: 2, vector3: 3, vector4: 4, quat: 5 } as const
