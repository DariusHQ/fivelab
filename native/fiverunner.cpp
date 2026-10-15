/*
** FiveRunner bridge: a small C ABI over CfxLua for the JavaScript host.
**
** CfxLua is compiled as C++, so the Lua API has C++ linkage. Everything the
** host calls is exported here with C linkage and an `fr_` prefix, which keeps
** the WebAssembly export names stable.
**
** Conventions:
** - Functions that push values reserve the stack space they need, so the host
**   never has to call lua_checkstack itself.
** - Functions documented as protected never raise. Everything else may raise
**   a Lua error: inside a host call that error unwinds to the enclosing
**   protected call, and outside of one Lua panics (see fr_panic).
*/

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>
#include <emscripten/stack.h>

#include "lua.hpp"
#include "lgrit_lib.h"
#include "lglmlib.hpp"
#include "lua_cmsgpacklib.h"
#include "lua_rapidjsonlib.h"

/*
** {======================================================
** Host imports
** =======================================================
*/

#define FR_IMPORT(name) __attribute__((import_module("fiverunner"), import_name(name)))

extern "C" {

/*
** Calls host function `fn` with `nargs` arguments on the stack of L. Returns
** the number of results it pushed, or -1 after pushing an error object.
*/
FR_IMPORT("call") int fr_host_call(int vm, lua_State *L, int fn, int nargs);

/* Runs on every count hook. Returns 1 after pushing an error object to raise. */
FR_IMPORT("hook") int fr_host_hook(int vm, lua_State *L);

/* Unprotected error: the error object is on top of the stack. Never returns. */
FR_IMPORT("panic") void fr_host_panic(int vm, lua_State *L);

/* One piece of a warning; `tocont` is 1 when more pieces of it follow. */
FR_IMPORT("warn") void fr_host_warn(int vm, const char *msg, size_t len, int tocont);

void _emscripten_stack_restore(uintptr_t sp);

}

/* }====================================================== */


/*
** {======================================================
** States
** =======================================================
*/

/* Per-state allocator data, also used to map a lua_State back to its VM. */
struct FRState {
  size_t used;  /* bytes currently allocated by this state */
  size_t limit;  /* allocation limit in bytes; 0 means unlimited */
  int vm;  /* host identifier of the VM */
};

static FRState *fr_state(lua_State *L) {
  void *ud = NULL;
  lua_getallocf(L, &ud);
  return static_cast<FRState *>(ud);
}

/*
** lua_Alloc with accounting. When `ptr` is NULL, `osize` encodes the type of
** the new object instead of a size, so it does not count as allocated memory.
*/
static void *fr_alloc(void *ud, void *ptr, size_t osize, size_t nsize) {
  FRState *s = static_cast<FRState *>(ud);
  size_t old = (ptr != NULL) ? osize : 0;
  if (nsize == 0) {
    free(ptr);
    s->used -= old;
    return NULL;
  }
  if (s->limit != 0 && nsize > old) {
    size_t extra = nsize - old;
    if (s->used > s->limit || extra > s->limit - s->used)
      return NULL;  /* Lua raises a memory error */
  }
  void *block = realloc(ptr, nsize);
  if (block != NULL)
    s->used = s->used - old + nsize;
  return block;
}

static int fr_panic(lua_State *L) {
  fr_host_panic(fr_state(L)->vm, L);
  __builtin_trap();  /* the host must not return */
}

/* Forwards every warning to the host, control messages included, as FiveM does. */
static void fr_warn(void *ud, const char *msg, int tocont) {
  fr_host_warn(static_cast<FRState *>(ud)->vm, msg, strlen(msg), tocont);
}

/* }====================================================== */


/*
** {======================================================
** Internal C functions
** =======================================================
*/

/* Message handler for fr_pcall: records a traceback, keeps the error object. */
static char fr_traceback_key;

static int fr_msgh(lua_State *L) {
  luaL_traceback(L, L, NULL, 1);
  lua_rawsetp(L, LUA_REGISTRYINDEX, &fr_traceback_key);
  return 1;
}

/*
** Calls a host function. A host function that fails leaves its message on
** the stack, and says how to raise it: -1 as it is, -2 as luaL_argerror
** does, with the index of the argument above the message, and -3 as
** luaL_error does, after the position of the caller.
*/
static int fr_hostfunction(lua_State *L) {
  int fn = static_cast<int>(lua_tointeger(L, lua_upvalueindex(1)));
  int n = fr_host_call(fr_state(L)->vm, L, fn, lua_gettop(L));
  if (n == -2) {
    int arg = static_cast<int>(lua_tointeger(L, -1));
    lua_pop(L, 1);
    return luaL_argerror(L, arg, lua_tostring(L, -1));
  }
  if (n == -3) {
    luaL_where(L, 1);
    lua_insert(L, -2);
    lua_concat(L, 2);
  }
  if (n < 0)
    return lua_error(L);
  return n;
}

static void fr_hook(lua_State *L, lua_Debug *ar) {
  (void)ar;
  if (fr_host_hook(fr_state(L)->vm, L) != 0) {
    if (lua_type(L, -1) == LUA_TSTRING) {  /* add the position, as luaL_error does */
      luaL_where(L, 0);
      lua_insert(L, -2);
      lua_concat(L, 2);
    }
    lua_error(L);
  }
}

/*
** FiveM's require: it only returns libraries that are already loaded and
** opens 'glm' on demand (also setting the global, as luaL_requiref does).
*/
static int fr_require(lua_State *L) {
  const char *name = luaL_checkstring(L, 1);
  lua_settop(L, 1);
  lua_getfield(L, LUA_REGISTRYINDEX, LUA_LOADED_TABLE);
  lua_getfield(L, 2, name);
  if (lua_toboolean(L, -1))
    return 1;
  if (strcmp(name, LUA_GLMLIBNAME) == 0) {
    luaL_requiref(L, LUA_GLMLIBNAME, luaopen_glm, 1);
    return 1;
  }
  return luaL_error(L, "module '%s' not found", name);
}

/* Writes the string at `index` to the console with the function in upvalue 1. */
static void fr_write(lua_State *L, int index) {
  index = lua_absindex(L, index);
  lua_pushvalue(L, lua_upvalueindex(1));
  lua_pushvalue(L, index);
  lua_call(L, 1, 0);
}

/*
** FiveM's print: converts each argument with the global tostring, looked up
** once per call, and writes each piece as soon as it has it, so the pieces
** before a failed conversion are written.
*/
static int fr_print(lua_State *L) {
  int n = lua_gettop(L);
  lua_getglobal(L, "tostring");
  for (int i = 1; i <= n; i++) {
    lua_pushvalue(L, -1);
    lua_pushvalue(L, i);
    lua_call(L, 1, 1);
    if (lua_tostring(L, -1) == NULL)
      return luaL_error(L, "'tostring' must return a string to 'print'");
    if (i > 1) {
      lua_pushliteral(L, "\t");
      fr_write(L, -1);
      lua_pop(L, 1);
    }
    fr_write(L, -1);
    lua_pop(L, 1);
  }
  lua_pushliteral(L, "\n");
  fr_write(L, -1);
  return 0;
}

/* FiveM's Citizen.Trace: writes a string, or a number, up to its first NUL. */
static int fr_trace(lua_State *L) {
  lua_pushstring(L, luaL_checkstring(L, 1));
  fr_write(L, -1);
  return 0;
}

static int fr_checkedcall_k(lua_State *L, int status, lua_KContext ctx) {
  (void)status;
  (void)ctx;
  return lua_gettop(L);
}

/*
** Calls the function in upvalue 2 after checking the arguments as upvalue 1
** says, one character for each: 's' for a string, 'n' for a number and 'i'
** for an integer, each taking what converts to one and passing on what it
** converts to, or '.' for any value. The checks run from the first argument
** to the last, or after a leading '<' from the last to the first, as some of
** FiveM's C functions check them. This is how FiveRunner implements in Lua what
** FiveM implements in C: argument errors name the function the way the
** script called it, and the function may yield.
*/
static int fr_checkedcall(lua_State *L) {
  size_t length;
  const char *checks = lua_tolstring(L, lua_upvalueindex(1), &length);
  const bool reversed = length > 0 && checks[0] == '<';
  if (reversed) {
    checks++;
    length--;
  }
  const int count = static_cast<int>(length);
  for (int n = 0; n < count; n++) {
    const int i = reversed ? count - n : n + 1;
    switch (checks[i - 1]) {
      case 's':
        luaL_checkstring(L, i);
        break;
      case 'n':
        lua_pushnumber(L, luaL_checknumber(L, i));
        lua_replace(L, i);
        break;
      case 'i':
        lua_pushinteger(L, luaL_checkinteger(L, i));
        lua_replace(L, i);
        break;
    }
  }
  lua_pushvalue(L, lua_upvalueindex(2));
  lua_insert(L, 1);
  lua_callk(L, lua_gettop(L) - 1, LUA_MULTRET, 0, fr_checkedcall_k);
  return fr_checkedcall_k(L, LUA_OK, 0);
}

/* checked(checks, fn): fn with its arguments checked as fr_checkedcall describes. */
static int fr_checked(lua_State *L) {
  luaL_checkstring(L, 1);
  luaL_checktype(L, 2, LUA_TFUNCTION);
  lua_settop(L, 2);
  lua_pushcclosure(L, fr_checkedcall, 2);
  return 1;
}

/* Libraries in the order FiveM opens them. */
enum {
  FR_LIB_BASE = 1 << 0,
  FR_LIB_TABLE = 1 << 1,
  FR_LIB_STRING = 1 << 2,
  FR_LIB_MATH = 1 << 3,
  FR_LIB_COROUTINE = 1 << 4,
  FR_LIB_UTF8 = 1 << 5,
  FR_LIB_DEBUG = 1 << 6,
  FR_LIB_MSGPACK = 1 << 7,
  FR_LIB_JSON = 1 << 8,
  FR_LIB_GLM = 1 << 9
};

static const struct {
  int bit;
  const char *name;
  lua_CFunction open;
} fr_libs[] = {
  {FR_LIB_BASE, LUA_GNAME, luaopen_base},
  {FR_LIB_TABLE, LUA_TABLIBNAME, luaopen_table},
  {FR_LIB_STRING, LUA_STRLIBNAME, luaopen_string},
  {FR_LIB_MATH, LUA_MATHLIBNAME, luaopen_math},
  {FR_LIB_COROUTINE, LUA_COLIBNAME, luaopen_coroutine},
  {FR_LIB_UTF8, LUA_UTF8LIBNAME, luaopen_utf8},
  {FR_LIB_DEBUG, LUA_DBLIBNAME, luaopen_debug},
  {FR_LIB_MSGPACK, LUA_MSGPACK_LIBNAME, luaopen_cmsgpack},
  {FR_LIB_JSON, LUA_RAPIDJSON_JSON_LIBNAME, luaopen_rapidjson},
  {FR_LIB_GLM, LUA_GLMLIBNAME, luaopen_glm},
};

static int fr_openlibs_k(lua_State *L) {
  int mask = static_cast<int>(lua_tointeger(L, 1));
  for (const auto &lib : fr_libs) {
    if (mask & lib.bit) {
      luaL_requiref(L, lib.name, lib.open, 1);
      lua_pop(L, 1);
    }
  }
  return 0;
}

static int fr_tostring_k(lua_State *L) {
  luaL_tolstring(L, 1, NULL);
  return 1;
}

/* }====================================================== */


/*
** {======================================================
** Natives
** =======================================================
*/

/*
** Citizen.InvokeNative and the functions around it, with FiveM's semantics.
** Arguments become 64-bit slots: nil and false are 0, true is 1, integers
** keep their bits, floats become 32-bit float bits, strings are pointers,
** vectors take one float slot per component and tables pass their __data.
** Light userdata markers ask for out-pointers or choose how to read the
** result. The marshalled call goes to a host function, which runs the
** native and returns its results.
*/

#define FR_NATIVE_ARGS 32
#define FR_NATIVE_RETVALS 16
#define FR_POINTER_FIELDS 128

/* What a marker asks for, in the order of FiveM's fx::invoker::MetaField. */
enum {
  FR_META_POINTER_INT,
  FR_META_POINTER_FLOAT,
  FR_META_POINTER_VECTOR,
  FR_META_RETURN_ANYWAY,
  FR_META_RESULT_INT,
  FR_META_RESULT_LONG,
  FR_META_RESULT_FLOAT,
  FR_META_RESULT_STRING,
  FR_META_RESULT_VECTOR,
  FR_META_RESULT_OBJECT,
  FR_META_MAX
};

/* An argument's type word: flags, and the size of what a pointer points to. */
#define FR_ARG_POINTER 0x80000000u
#define FR_ARG_STRING 0x40000000u
#define FR_ARG_SIZE 0x1fffffffu

/* The kind of Lua value an argument slot came from. */
enum {
  FR_SOURCE_NIL,
  FR_SOURCE_BOOLEAN,
  FR_SOURCE_INTEGER,
  FR_SOURCE_FLOAT,
  FR_SOURCE_STRING,
  FR_SOURCE_VECTOR,
  FR_SOURCE_POINTER
};

/* A marshalled call, read and completed by the host. The layout is part of the ABI. */
struct FRNativeCall {
  uint64_t hash;
  uint64_t arguments[FR_NATIVE_ARGS];
  uint64_t results[4];  /* the primary result; a vector takes three slots */
  uint64_t buffers[3 * FR_NATIVE_RETVALS];  /* what out-pointer arguments point to */
  uint32_t types[FR_NATIVE_ARGS];
  uint32_t retvals[FR_NATIVE_RETVALS];  /* where each result is; the first is `results` */
  uint8_t rettypes[FR_NATIVE_RETVALS];  /* how to read each one: FR_META_*, or FR_META_MAX */
  uint8_t sources[FR_NATIVE_ARGS];
  uint32_t nargs;
  uint32_t nretvals;
  uint32_t nbuffers;  /* slots of `buffers` in use */
  const char *error;  /* why marshalling failed, or NULL */
  uint32_t failed;  /* set by the invoker when the native failed; its only result is the error */
};

static_assert(offsetof(FRNativeCall, arguments) == 8, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, results) == 264, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, buffers) == 296, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, types) == 680, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, retvals) == 808, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, rettypes) == 872, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, sources) == 888, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, nargs) == 920, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, nretvals) == 924, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, nbuffers) == 928, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, error) == 932, "FRNativeCall layout");
static_assert(offsetof(FRNativeCall, failed) == 936, "FRNativeCall layout");

/* Markers point into these, so they compare equal to themselves as in FiveM. */
static uint8_t fr_metafields[FR_META_MAX];

/*
** PointerValueIntInitialized and PointerValueFloatInitialized markers. Like
** FiveM, they come from a ring that the module shares between its states.
*/
struct FRPointerField {
  uint64_t value[3];
  uint8_t type;
};

static FRPointerField fr_pointerfields[FR_POINTER_FIELDS];
static unsigned fr_nextpointerfield = 0;

static char fr_awaitsentinel;

/* Formatted marshalling errors; a call fails at its first error. */
static char fr_nativeerror[64];

static int fr_nativefail(FRNativeCall *call, const char *error) {
  call->error = error;
  return 0;
}

/* Returns the first of `n` free slots, or -1 after failing the call. */
static int fr_nativereserve(FRNativeCall *call, uint32_t n) {
  if (FR_NATIVE_ARGS - call->nargs < n) {
    fr_nativefail(call, "too many arguments");
    return -1;
  }
  return static_cast<int>(call->nargs);
}

static void fr_nativeset(FRNativeCall *call, int slot, uint64_t value, uint32_t type, uint8_t source) {
  call->arguments[slot] = value;
  call->types[slot] = type;
  call->sources[slot] = source;
  call->nargs = static_cast<uint32_t>(slot) + 1;
}

static uint64_t fr_floatbits(float f) {
  uint32_t bits;
  memcpy(&bits, &f, sizeof(bits));
  return bits;
}

/* Adds an out-pointer argument, its buffer initialized from `init` or zeroed. */
static int fr_nativeretval(FRNativeCall *call, int field, const uint64_t *init) {
  if (call->nretvals >= FR_NATIVE_RETVALS)
    return fr_nativefail(call, "too many return value arguments");
  uint32_t words = (field == FR_META_POINTER_VECTOR) ? 3 : 1;
  uint64_t *buffer = &call->buffers[call->nbuffers];
  call->nbuffers += words;
  for (uint32_t i = 0; i < words; i++)
    buffer[i] = (init != NULL) ? init[i] : 0;
  call->retvals[call->nretvals] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(buffer));
  call->rettypes[call->nretvals] = static_cast<uint8_t>(field);
  call->nretvals++;
  int slot = fr_nativereserve(call, 1);
  if (slot < 0)
    return 0;
  fr_nativeset(call, slot, reinterpret_cast<uintptr_t>(buffer),
               FR_ARG_POINTER | static_cast<uint32_t>(words * sizeof(uint64_t)), FR_SOURCE_POINTER);
  return 1;
}

static int fr_nativemarker(FRNativeCall *call, void *p) {
  uint8_t *ptr = static_cast<uint8_t *>(p);
  if (ptr >= fr_metafields && ptr < fr_metafields + FR_META_MAX) {
    int field = static_cast<int>(ptr - fr_metafields);
    switch (field) {
      case FR_META_POINTER_INT:
      case FR_META_POINTER_FLOAT:
      case FR_META_POINTER_VECTOR:
        return fr_nativeretval(call, field, NULL);
      case FR_META_RETURN_ANYWAY:
        if (call->rettypes[0] == FR_META_MAX)
          call->rettypes[0] = FR_META_RETURN_ANYWAY;
        return 1;
      default:
        call->rettypes[0] = static_cast<uint8_t>(field);
        return 1;
    }
  }
  uint8_t *fields = reinterpret_cast<uint8_t *>(fr_pointerfields);
  if (ptr >= fields && ptr < fields + sizeof(fr_pointerfields)) {
    FRPointerField *field = reinterpret_cast<FRPointerField *>(ptr);
    return fr_nativeretval(call, field->type, field->value);
  }
  return fr_nativefail(call, "unknown userdata pointer");
}

static int fr_nativearg(lua_State *L, FRNativeCall *call, int idx);

/*
** Marshals the value on top, which came from a table's __data: returns 1 or
** 0 as fr_nativearg does, or -1 when values of this type cannot be passed.
** Strings stay on the stack so that the pointer to them remains valid.
*/
static int fr_nativedata(lua_State *L, FRNativeCall *call, int type) {
  switch (type) {
    case LUA_TBOOLEAN:
    case LUA_TNUMBER:
    case LUA_TVECTOR:
    case LUA_TSTRING: {
      int ok = fr_nativearg(L, call, lua_gettop(L));
      if (type != LUA_TSTRING)
        lua_pop(L, 1);
      return ok;
    }
    default:
      lua_pop(L, 1);
      return -1;
  }
}

/* A table passes its __data field, or the __data of its metatable, calling it if it is a function. */
static int fr_nativetable(lua_State *L, FRNativeCall *call, int idx) {
  idx = lua_absindex(L, idx);
  luaL_checkstack(L, 2, "table arguments");
  lua_pushliteral(L, "__data");
  int done = fr_nativedata(L, call, lua_rawget(L, idx));
  if (done >= 0)
    return done;
  int type = luaL_getmetafield(L, idx, "__data");
  if (type == LUA_TNIL)
    return fr_nativefail(call, "invalid table argument");
  if (type == LUA_TFUNCTION) {
    lua_pushvalue(L, idx);
    lua_call(L, 1, 1);
    type = lua_type(L, -1);
  }
  done = fr_nativedata(L, call, type);
  if (done >= 0)
    return done;
  return fr_nativefail(call, "invalid lua type in __data");
}

/* Marshals argument `idx`; returns 0 after failing the call. */
static int fr_nativearg(lua_State *L, FRNativeCall *call, int idx) {
  int slot = fr_nativereserve(call, 1);
  if (slot < 0)
    return 0;
  int type = lua_type(L, idx);
  switch (type) {
    case LUA_TNIL:
      fr_nativeset(call, slot, 0, 0, FR_SOURCE_NIL);
      return 1;
    case LUA_TBOOLEAN:
      fr_nativeset(call, slot, lua_toboolean(L, idx) ? 1 : 0, 0, FR_SOURCE_BOOLEAN);
      return 1;
    case LUA_TNUMBER:
      if (lua_isinteger(L, idx))
        fr_nativeset(call, slot, static_cast<uint64_t>(lua_tointeger(L, idx)), 0, FR_SOURCE_INTEGER);
      else
        fr_nativeset(call, slot, fr_floatbits(static_cast<float>(lua_tonumber(L, idx))), 0, FR_SOURCE_FLOAT);
      return 1;
    case LUA_TSTRING: {
      size_t len;
      const char *s = lua_tolstring(L, idx, &len);
      fr_nativeset(call, slot, reinterpret_cast<uintptr_t>(s),
                   FR_ARG_POINTER | FR_ARG_STRING | (static_cast<uint32_t>(len) & FR_ARG_SIZE), FR_SOURCE_STRING);
      return 1;
    }
    case LUA_TVECTOR: {
      lua_Float4 v;
      int variant = lua_tovector(L, idx, V_NONUMBER, &v);
      uint32_t n = (variant == LUA_VVECTOR2) ? 2 : (variant == LUA_VVECTOR3) ? 3 : 4;
      slot = fr_nativereserve(call, n);
      if (slot < 0)
        return 0;
      const float components[4] = {v.x, v.y, v.z, v.w};
      for (uint32_t i = 0; i < n; i++)
        fr_nativeset(call, slot + static_cast<int>(i), fr_floatbits(components[i]), 0, FR_SOURCE_VECTOR);
      return 1;
    }
    case LUA_TTABLE:
      return fr_nativetable(L, call, idx);
    case LUA_TLIGHTUSERDATA:
      return fr_nativemarker(call, lua_touserdata(L, idx));
    default:
      snprintf(fr_nativeerror, sizeof(fr_nativeerror), "invalid lua type: %s", lua_typename(L, type));
      return fr_nativefail(call, fr_nativeerror);
  }
}

/*
** Marshals the arguments from `first` up and returns what host function
** `invoker` returns for the call. Marshalling errors go to the host too, which
** reports them the way FiveM reports native errors. A native that fails
** raises its error from the calling function, as FiveM's do, so that error
** handlers find the script's caller right below it.
*/
static int fr_invoke(lua_State *L, uint64_t hash, int first, int invoker) {
  FRNativeCall call;
  call.hash = hash;
  memset(call.results, 0, sizeof(call.results));
  call.retvals[0] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(call.results));
  call.rettypes[0] = FR_META_MAX;
  call.nargs = 0;
  call.nretvals = 1;
  call.nbuffers = 0;
  call.error = NULL;
  call.failed = 0;
  int top = lua_gettop(L);
  for (int i = first; i <= top; i++) {
    if (!fr_nativearg(L, &call, i))
      break;
  }
  luaL_checkstack(L, 2, NULL);
  int base = lua_gettop(L);
  lua_pushvalue(L, invoker);
  lua_pushinteger(L, static_cast<lua_Integer>(reinterpret_cast<uintptr_t>(&call)));
  lua_call(L, 1, LUA_MULTRET);
  if (call.failed)
    return lua_error(L);
  return lua_gettop(L) - base;
}

/* Citizen.InvokeNative(hash, ...); upvalue 1 is the invoker. */
static int fr_invokenative(lua_State *L) {
  return fr_invoke(L, static_cast<uint64_t>(lua_tointeger(L, 1)), 2, lua_upvalueindex(1));
}

/* A function from Citizen.GetNative; upvalue 1 is the hash and upvalue 2 the invoker. */
static int fr_nativehandler(lua_State *L) {
  return fr_invoke(L, static_cast<uint64_t>(lua_tointeger(L, lua_upvalueindex(1))), 1, lua_upvalueindex(2));
}

/* FiveM's HashString: joaat up to the first NUL, with ASCII lowercased and chars signed. */
static uint32_t fr_hashstring(const char *s) {
  uint32_t hash = 0;
  for (; *s != '\0'; s++) {
    signed char c = static_cast<signed char>(*s);
    if (c >= 'A' && c <= 'Z')
      c = static_cast<signed char>(c - 'A' + 'a');
    hash += static_cast<uint32_t>(static_cast<int32_t>(c));
    hash += hash << 10;
    hash ^= hash >> 6;
  }
  hash += hash << 3;
  hash ^= hash >> 11;
  hash += hash << 15;
  return hash;
}

#define FR_GET_HASH_KEY UINT64_C(0xD24D37CC275948CC)

/* The function Citizen.GetNative returns for GET_HASH_KEY, which hashes without invoking the native. */
static int fr_gethashkey(lua_State *L) {
  if (lua_isnil(L, 1) || lua_type(L, 1) == LUA_TNUMBER) {
    lua_pushinteger(L, 0);
    return 1;
  }
  const char *s = luaL_checkstring(L, 1);
  lua_pushinteger(L, static_cast<lua_Integer>(static_cast<int32_t>(fr_hashstring(s))));
  return 1;
}

/* Citizen.GetNative(hash); upvalue 1 is the invoker. */
static int fr_getnative(lua_State *L) {
  uint64_t hash = static_cast<uint64_t>(lua_tointeger(L, 1));
  lua_pushinteger(L, static_cast<lua_Integer>(hash));
  if (hash == FR_GET_HASH_KEY) {
    lua_pushcclosure(L, fr_gethashkey, 1);
  } else {
    lua_pushvalue(L, lua_upvalueindex(1));
    lua_pushcclosure(L, fr_nativehandler, 2);
  }
  return 1;
}

/* Citizen.InvokeNative2(handler, ...), deprecated in FiveM; upvalue 1 is the invoker. */
static int fr_invokenative2(lua_State *L) {
  luaL_argcheck(L, lua_getupvalue(L, 1, 1) != NULL, 1, "invalid native handler");
  uint64_t hash = static_cast<uint64_t>(luaL_checkinteger(L, -1));
  lua_pop(L, 1);
  return fr_invoke(L, hash, 2, lua_upvalueindex(1));
}

template <int field>
static int fr_metafield(lua_State *L) {
  lua_pushlightuserdata(L, &fr_metafields[field]);
  return 1;
}

static FRPointerField *fr_pointerfield(int type, uint64_t value) {
  FRPointerField *field = &fr_pointerfields[fr_nextpointerfield];
  fr_nextpointerfield = (fr_nextpointerfield + 1) % FR_POINTER_FIELDS;
  field->type = static_cast<uint8_t>(type);
  for (uint64_t &word : field->value)
    word = value;
  return field;
}

/* Values that are no number, such as an accidental _r marker, initialize to 0. */
static bool fr_pointerinit(lua_State *L) {
  int type = lua_type(L, 1);
  return type != LUA_TNIL && type != LUA_TLIGHTUSERDATA && type != LUA_TUSERDATA;
}

static int fr_pointervalueintinitialized(lua_State *L) {
  uint64_t value = fr_pointerinit(L) ? static_cast<uint64_t>(luaL_checkinteger(L, 1)) : 0;
  lua_pushlightuserdata(L, fr_pointerfield(FR_META_POINTER_INT, value));
  return 1;
}

/*
** FiveM checks the number but stores 0: it reinterprets the variable that
** holds the result instead of the converted float. Scripts see that, so this
** does the same.
*/
static int fr_pointervaluefloatinitialized(lua_State *L) {
  if (fr_pointerinit(L))
    luaL_checknumber(L, 1);
  lua_pushlightuserdata(L, fr_pointerfield(FR_META_POINTER_FLOAT, 0));
  return 1;
}

static int fr_awaitsentinel_k(lua_State *L) {
  lua_pushlightuserdata(L, &fr_awaitsentinel);
  return 1;
}

static int fr_noop(lua_State *L) {
  (void)L;
  return 0;
}

/* C functions the host can push by number, after the upvalues they take. */
enum {
  FR_CFUNC_REQUIRE = 1,
  FR_CFUNC_INVOKE_NATIVE,  /* upvalue: the invoker */
  FR_CFUNC_GET_NATIVE,  /* upvalue: the invoker */
  FR_CFUNC_INVOKE_NATIVE2,  /* upvalue: the invoker */
  FR_CFUNC_POINTER_VALUE_INT,
  FR_CFUNC_POINTER_VALUE_FLOAT,
  FR_CFUNC_POINTER_VALUE_VECTOR,
  FR_CFUNC_RETURN_RESULT_ANYWAY,
  FR_CFUNC_RESULT_AS_INTEGER,
  FR_CFUNC_RESULT_AS_LONG,
  FR_CFUNC_RESULT_AS_FLOAT,
  FR_CFUNC_RESULT_AS_STRING,
  FR_CFUNC_RESULT_AS_VECTOR,
  FR_CFUNC_RESULT_AS_OBJECT,  /* the marker; Citizen.ResultAsObject itself does nothing */
  FR_CFUNC_POINTER_VALUE_INT_INITIALIZED,
  FR_CFUNC_POINTER_VALUE_FLOAT_INITIALIZED,
  FR_CFUNC_AWAIT_SENTINEL,
  FR_CFUNC_NOOP,
  FR_CFUNC_PRINT,  /* upvalue: a function that writes to the console */
  FR_CFUNC_TRACE,  /* upvalue: a function that writes to the console */
  FR_CFUNC_CHECKED,
  FR_CFUNC_COUNT
};

static const lua_CFunction fr_cfunctions[] = {
  NULL,
  fr_require,
  fr_invokenative,
  fr_getnative,
  fr_invokenative2,
  fr_metafield<FR_META_POINTER_INT>,
  fr_metafield<FR_META_POINTER_FLOAT>,
  fr_metafield<FR_META_POINTER_VECTOR>,
  fr_metafield<FR_META_RETURN_ANYWAY>,
  fr_metafield<FR_META_RESULT_INT>,
  fr_metafield<FR_META_RESULT_LONG>,
  fr_metafield<FR_META_RESULT_FLOAT>,
  fr_metafield<FR_META_RESULT_STRING>,
  fr_metafield<FR_META_RESULT_VECTOR>,
  fr_metafield<FR_META_RESULT_OBJECT>,
  fr_pointervalueintinitialized,
  fr_pointervaluefloatinitialized,
  fr_awaitsentinel_k,
  fr_noop,
  fr_print,
  fr_trace,
  fr_checked,
};

static_assert(sizeof(fr_cfunctions) / sizeof(fr_cfunctions[0]) == FR_CFUNC_COUNT, "one C function per number");

/* }====================================================== */


extern "C" {

/*
** {======================================================
** Lifecycle
** =======================================================
*/

/* Creates a state for VM `vm`, without libraries. Returns NULL when out of memory. */
EMSCRIPTEN_KEEPALIVE lua_State *fr_newstate(int vm) {
  FRState *s = static_cast<FRState *>(malloc(sizeof(FRState)));
  if (s == NULL)
    return NULL;
  s->used = 0;
  s->limit = 0;
  s->vm = vm;
  lua_State *L = lua_newstate(fr_alloc, s);
  if (L == NULL) {
    free(s);
    return NULL;
  }
  lua_atpanic(L, fr_panic);
  lua_setwarnf(L, fr_warn, s);
  lua_gc(L, LUA_GCGEN, 0, 0);  /* FiveM runs its collectors in generational mode */
  return L;
}

EMSCRIPTEN_KEEPALIVE void fr_close(lua_State *L) {
  FRState *s = fr_state(L);
  lua_close(L);
  free(s);
}

/* Protected. Opens the libraries in `mask`; on error leaves the message. */
EMSCRIPTEN_KEEPALIVE int fr_openlibs(lua_State *L, int mask) {
  luaL_checkstack(L, 2, NULL);
  lua_pushcfunction(L, fr_openlibs_k);
  lua_pushinteger(L, mask);
  return lua_pcall(L, 1, 0, 0);
}

EMSCRIPTEN_KEEPALIVE size_t fr_memused(lua_State *L) {
  return fr_state(L)->used;
}

EMSCRIPTEN_KEEPALIVE size_t fr_getmemlimit(lua_State *L) {
  return fr_state(L)->limit;
}

EMSCRIPTEN_KEEPALIVE void fr_setmemlimit(lua_State *L, size_t limit) {
  fr_state(L)->limit = limit;
}

EMSCRIPTEN_KEEPALIVE int fr_gc(lua_State *L, int what, int arg) {
  return lua_gc(L, what, arg);
}

/* Count hook every `count` instructions, inherited by new threads. */
EMSCRIPTEN_KEEPALIVE void fr_sethook(lua_State *L, int count) {
  if (count > 0)
    lua_sethook(L, fr_hook, LUA_MASKCOUNT, count);
  else
    lua_sethook(L, NULL, 0, 0);
}

EMSCRIPTEN_KEEPALIVE uintptr_t fr_stacksave(void) {
  return emscripten_stack_get_current();
}

EMSCRIPTEN_KEEPALIVE void fr_stackrestore(uintptr_t sp) {
  _emscripten_stack_restore(sp);
}

/* }====================================================== */


/*
** {======================================================
** Stack
** =======================================================
*/

EMSCRIPTEN_KEEPALIVE int fr_gettop(lua_State *L) {
  return lua_gettop(L);
}

EMSCRIPTEN_KEEPALIVE void fr_settop(lua_State *L, int idx) {
  lua_settop(L, idx);
}

EMSCRIPTEN_KEEPALIVE void fr_pushvalue(lua_State *L, int idx) {
  luaL_checkstack(L, 1, NULL);
  lua_pushvalue(L, idx);
}

EMSCRIPTEN_KEEPALIVE int fr_type(lua_State *L, int idx) {
  return lua_type(L, idx);
}

/* }====================================================== */


/*
** {======================================================
** Push
** =======================================================
*/

EMSCRIPTEN_KEEPALIVE void fr_pushnil(lua_State *L) {
  luaL_checkstack(L, 1, NULL);
  lua_pushnil(L);
}

EMSCRIPTEN_KEEPALIVE void fr_pushboolean(lua_State *L, int b) {
  luaL_checkstack(L, 1, NULL);
  lua_pushboolean(L, b);
}

/* `n` is integral; the host passes doubles to avoid BigInt conversions. */
EMSCRIPTEN_KEEPALIVE void fr_pushinteger(lua_State *L, double n) {
  luaL_checkstack(L, 1, NULL);
  lua_pushinteger(L, static_cast<lua_Integer>(n));
}

EMSCRIPTEN_KEEPALIVE void fr_pushinteger64(lua_State *L, int64_t n) {
  luaL_checkstack(L, 1, NULL);
  lua_pushinteger(L, static_cast<lua_Integer>(n));
}

EMSCRIPTEN_KEEPALIVE void fr_pushnumber(lua_State *L, double n) {
  luaL_checkstack(L, 1, NULL);
  lua_pushnumber(L, static_cast<lua_Number>(n));
}

EMSCRIPTEN_KEEPALIVE void fr_pushlstring(lua_State *L, const char *s, size_t len) {
  luaL_checkstack(L, 1, NULL);
  lua_pushlstring(L, s, len);
}

/* `kind` is 2, 3 or 4 for vectors and 5 for quaternions. */
EMSCRIPTEN_KEEPALIVE void fr_pushvector(lua_State *L, int kind, float x, float y, float z, float w) {
  static const int variants[] = {LUA_VVECTOR2, LUA_VVECTOR3, LUA_VVECTOR4, LUA_VQUAT};
  luaL_checkstack(L, 1, NULL);
  lua_Float4 v;
  v.x = x;
  v.y = y;
  v.z = z;
  v.w = w;
  lua_pushvector(L, v, variants[(kind - 2) & 3]);
}

/* Pushes a Lua function that calls host function `fn`. */
EMSCRIPTEN_KEEPALIVE void fr_pushhostfunction(lua_State *L, int fn) {
  luaL_checkstack(L, 1, NULL);
  lua_pushinteger(L, fn);
  lua_pushcclosure(L, fr_hostfunction, 1);
}

/* Pushes C function `which`, closing over the `nup` values on top of the stack. */
EMSCRIPTEN_KEEPALIVE void fr_pushcfunction(lua_State *L, int which, int nup) {
  luaL_checkstack(L, 1, NULL);
  if (which > 0 && which < FR_CFUNC_COUNT) {
    lua_pushcclosure(L, fr_cfunctions[which], nup);
  } else {
    lua_pop(L, nup);
    lua_pushnil(L);
  }
}

EMSCRIPTEN_KEEPALIVE void fr_pushglobaltable(lua_State *L) {
  luaL_checkstack(L, 1, NULL);
  lua_pushglobaltable(L);
}

/* }====================================================== */


/*
** {======================================================
** Read
** =======================================================
*/

EMSCRIPTEN_KEEPALIVE int fr_toboolean(lua_State *L, int idx) {
  return lua_toboolean(L, idx);
}

EMSCRIPTEN_KEEPALIVE double fr_tonumber(lua_State *L, int idx) {
  return static_cast<double>(lua_tonumber(L, idx));
}

EMSCRIPTEN_KEEPALIVE int64_t fr_tointeger64(lua_State *L, int idx) {
  return static_cast<int64_t>(lua_tointeger(L, idx));
}

EMSCRIPTEN_KEEPALIVE int fr_isinteger(lua_State *L, int idx) {
  return lua_isinteger(L, idx);
}

/* Whether the value converts to an integer, as lua_tointegerx tells. */
EMSCRIPTEN_KEEPALIVE int fr_isintegral(lua_State *L, int idx) {
  int isnum = 0;
  lua_tointegerx(L, idx, &isnum);
  return isnum;
}

/* Whether the value is a number or a string that converts to one. */
EMSCRIPTEN_KEEPALIVE int fr_isnumber(lua_State *L, int idx) {
  return lua_isnumber(L, idx);
}

/* Converts numbers in place, like lua_tolstring. */
EMSCRIPTEN_KEEPALIVE const char *fr_tolstring(lua_State *L, int idx, size_t *len) {
  return lua_tolstring(L, idx, len);
}

/*
** Writes the components to out[4] and returns the kind (2, 3, 4, or 5 for
** quaternions), or 0 when the value is not a vector.
*/
EMSCRIPTEN_KEEPALIVE int fr_tovector(lua_State *L, int idx, float *out) {
  lua_Float4 v;
  int variant = lua_tovector(L, idx, V_NONUMBER, &v);
  if (variant == 0)
    return 0;
  out[0] = v.x;
  out[1] = v.y;
  out[2] = v.z;
  out[3] = v.w;
  return (variant == LUA_VQUAT) ? 5 : luaVec_dimensions(variant);
}

/*
** Protected. Pushes tostring(value) and returns 1, or pushes a description
** of the failure and returns 0.
*/
EMSCRIPTEN_KEEPALIVE int fr_tostring(lua_State *L, int idx) {
  idx = lua_absindex(L, idx);
  luaL_checkstack(L, 2, NULL);
  lua_pushcfunction(L, fr_tostring_k);
  lua_pushvalue(L, idx);
  if (lua_pcall(L, 1, 1, 0) == LUA_OK)
    return 1;
  if (lua_type(L, -1) != LUA_TSTRING) {
    lua_pop(L, 1);
    lua_pushliteral(L, "(error object is not a string)");
  }
  return 0;
}

/* }====================================================== */


/*
** {======================================================
** Tables and references
** =======================================================
*/

/* Replaces the key on top with its value in the table at `idx`, without metamethods. */
EMSCRIPTEN_KEEPALIVE int fr_rawget(lua_State *L, int idx) {
  return lua_rawget(L, idx);
}

/*
** Replaces the key on top with its value in the value at `idx`, with its
** metamethods, as lua_getfield reads fields. Only host calls use it, whose
** Lua frame catches what the metamethods raise.
*/
EMSCRIPTEN_KEEPALIVE int fr_gettable(lua_State *L, int idx) {
  return lua_gettable(L, idx);
}

/* Pushes a new table with room for `narr` items and `nrec` fields. */
EMSCRIPTEN_KEEPALIVE void fr_createtable(lua_State *L, int narr, int nrec) {
  lua_createtable(L, narr, nrec);
}

/*
** Pops a library and its name, which it loads as luaL_requiref does with a
** global: in the table of loaded modules, which require and the names of
** functions in errors read, and as the global of its name.
*/
EMSCRIPTEN_KEEPALIVE void fr_setlib(lua_State *L) {
  const char *name = lua_tostring(L, -2);
  luaL_getsubtable(L, LUA_REGISTRYINDEX, LUA_LOADED_TABLE);
  lua_pushvalue(L, -2);
  lua_setfield(L, -2, name);
  lua_pop(L, 1);
  lua_setglobal(L, name);
  lua_pop(L, 1);
}

/* Pops a key and a value into the table at `idx`, without metamethods. */
EMSCRIPTEN_KEEPALIVE void fr_rawset(lua_State *L, int idx) {
  lua_rawset(L, idx);
}

/* Pops a value and stores it in the registry, returning its reference. */
EMSCRIPTEN_KEEPALIVE int fr_ref(lua_State *L) {
  return luaL_ref(L, LUA_REGISTRYINDEX);
}

EMSCRIPTEN_KEEPALIVE void fr_unref(lua_State *L, int ref) {
  luaL_unref(L, LUA_REGISTRYINDEX, ref);
}

EMSCRIPTEN_KEEPALIVE int fr_getref(lua_State *L, int ref) {
  luaL_checkstack(L, 1, NULL);
  return lua_rawgeti(L, LUA_REGISTRYINDEX, ref);
}

/* }====================================================== */


/*
** {======================================================
** Loading and calling
** =======================================================
*/

/*
** Protected. Pushes the compiled chunk, or the error message. `name` and
** `mode` are C strings; a NULL mode allows text and binary chunks.
*/
EMSCRIPTEN_KEEPALIVE int fr_load(lua_State *L, const char *buf, size_t len, const char *name, const char *mode) {
  luaL_checkstack(L, 1, NULL);
  return luaL_loadbufferx(L, buf, len, name, mode);
}

/*
** Protected. Calls the function below the `nargs` arguments on top of the
** stack. On error, leaves the error object and records a traceback that
** fr_traceback returns.
*/
EMSCRIPTEN_KEEPALIVE int fr_pcall(lua_State *L, int nargs, int nresults) {
  int base = lua_gettop(L) - nargs;
  luaL_checkstack(L, 1, NULL);
  lua_pushcfunction(L, fr_msgh);
  lua_insert(L, base);
  int status = lua_pcall(L, nargs, nresults, base);
  lua_remove(L, base);
  return status;
}

/* Pushes the traceback of the last failed fr_pcall (or nil) and clears it. */
EMSCRIPTEN_KEEPALIVE const char *fr_traceback(lua_State *L, size_t *len) {
  luaL_checkstack(L, 2, NULL);
  lua_rawgetp(L, LUA_REGISTRYINDEX, &fr_traceback_key);
  lua_pushnil(L);
  lua_rawsetp(L, LUA_REGISTRYINDEX, &fr_traceback_key);
  return lua_tolstring(L, -1, len);
}

/* }====================================================== */

}
