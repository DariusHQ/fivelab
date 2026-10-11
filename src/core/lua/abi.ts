/**
 * The C ABI of cfxlua.wasm, defined in native/fivelab.cpp. Pointers are
 * offsets into the module's linear memory.
 */

export type Ptr = number

export interface CfxLuaExports {
  readonly memory: WebAssembly.Memory
  _initialize(): void
  malloc(size: number): Ptr
  free(ptr: Ptr): void

  fl_newstate(vm: number): Ptr
  fl_close(L: Ptr): void
  fl_openlibs(L: Ptr, mask: number): number
  fl_memused(L: Ptr): number
  fl_getmemlimit(L: Ptr): number
  fl_setmemlimit(L: Ptr, limit: number): void
  fl_gc(L: Ptr, what: number, arg: number): number
  fl_sethook(L: Ptr, count: number): void
  fl_stacksave(): Ptr
  fl_stackrestore(sp: Ptr): void

  fl_gettop(L: Ptr): number
  fl_settop(L: Ptr, idx: number): void
  fl_pushvalue(L: Ptr, idx: number): void
  fl_type(L: Ptr, idx: number): number

  fl_pushnil(L: Ptr): void
  fl_pushboolean(L: Ptr, b: number): void
  fl_pushinteger(L: Ptr, n: number): void
  fl_pushinteger64(L: Ptr, n: bigint): void
  fl_pushnumber(L: Ptr, n: number): void
  fl_pushlstring(L: Ptr, s: Ptr, len: number): void
  fl_pushvector(L: Ptr, kind: number, x: number, y: number, z: number, w: number): void
  fl_pushhostfunction(L: Ptr, fn: number): void
  fl_pushcfunction(L: Ptr, which: number, nup: number): void
  fl_pushglobaltable(L: Ptr): void

  fl_toboolean(L: Ptr, idx: number): number
  fl_tonumber(L: Ptr, idx: number): number
  fl_tointeger64(L: Ptr, idx: number): bigint
  fl_isinteger(L: Ptr, idx: number): number
  fl_tolstring(L: Ptr, idx: number, len: Ptr): Ptr
  fl_tovector(L: Ptr, idx: number, out: Ptr): number
  fl_tostring(L: Ptr, idx: number): number

  fl_rawget(L: Ptr, idx: number): number
  fl_rawset(L: Ptr, idx: number): void
  fl_ref(L: Ptr): number
  fl_unref(L: Ptr, ref: number): void
  fl_getref(L: Ptr, ref: number): number

  fl_load(L: Ptr, buf: Ptr, len: number, name: Ptr, mode: Ptr): number
  fl_pcall(L: Ptr, nargs: number, nresults: number): number
  fl_traceback(L: Ptr, len: Ptr): Ptr
}

/** Functions the module imports from the "fivelab" namespace. */
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

/** Library bits for fl_openlibs, in the order FiveM opens them. */
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

/** C functions fl_pushcfunction can push, after the upvalues they take. */
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

/** Offsets in FLNativeCall, the marshalled native call that native/fivelab.cpp hands to the invoker. */
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

/** Vector kinds used by fl_pushvector and fl_tovector. */
export const VECTOR_KIND = { vector2: 2, vector3: 3, vector4: 4, quat: 5 } as const
