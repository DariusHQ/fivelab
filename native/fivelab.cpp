/*
** FiveLab bridge: a small C ABI over CfxLua for the JavaScript host.
**
** CfxLua is compiled as C++, so the Lua API has C++ linkage. Everything the
** host calls is exported here with C linkage and an `fl_` prefix, which keeps
** the WebAssembly export names stable.
**
** Conventions:
** - Functions that push values reserve the stack space they need, so the host
**   never has to call lua_checkstack itself.
** - Functions documented as protected never raise. Everything else may raise
**   a Lua error: inside a host call that error unwinds to the enclosing
**   protected call, and outside of one Lua panics (see fl_panic).
*/

#include <stddef.h>
#include <stdint.h>
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

#define FL_IMPORT(name) __attribute__((import_module("fivelab"), import_name(name)))

extern "C" {

/*
** Calls host function `fn` with `nargs` arguments on the stack of L. Returns
** the number of results it pushed, or -1 after pushing an error object.
*/
FL_IMPORT("call") int fl_host_call(int vm, lua_State *L, int fn, int nargs);

/* Runs on every count hook. Returns 1 after pushing an error object to raise. */
FL_IMPORT("hook") int fl_host_hook(int vm, lua_State *L);

/* Unprotected error: the error object is on top of the stack. Never returns. */
FL_IMPORT("panic") void fl_host_panic(int vm, lua_State *L);

/* One piece of a warning; `tocont` is 1 when more pieces of it follow. */
FL_IMPORT("warn") void fl_host_warn(int vm, const char *msg, size_t len, int tocont);

void _emscripten_stack_restore(uintptr_t sp);

}

/* }====================================================== */


/*
** {======================================================
** States
** =======================================================
*/

/* Per-state allocator data, also used to map a lua_State back to its VM. */
struct FLState {
  size_t used;  /* bytes currently allocated by this state */
  size_t limit;  /* allocation limit in bytes; 0 means unlimited */
  int vm;  /* host identifier of the VM */
};

static FLState *fl_state(lua_State *L) {
  void *ud = NULL;
  lua_getallocf(L, &ud);
  return static_cast<FLState *>(ud);
}

/*
** lua_Alloc with accounting. When `ptr` is NULL, `osize` encodes the type of
** the new object instead of a size, so it does not count as allocated memory.
*/
static void *fl_alloc(void *ud, void *ptr, size_t osize, size_t nsize) {
  FLState *s = static_cast<FLState *>(ud);
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

static int fl_panic(lua_State *L) {
  fl_host_panic(fl_state(L)->vm, L);
  __builtin_trap();  /* the host must not return */
}

/* Forwards every warning to the host, control messages included, as FiveM does. */
static void fl_warn(void *ud, const char *msg, int tocont) {
  fl_host_warn(static_cast<FLState *>(ud)->vm, msg, strlen(msg), tocont);
}

/* }====================================================== */


/*
** {======================================================
** Internal C functions
** =======================================================
*/

/* Message handler for fl_pcall: records a traceback, keeps the error object. */
static char fl_traceback_key;

static int fl_msgh(lua_State *L) {
  luaL_traceback(L, L, NULL, 1);
  lua_rawsetp(L, LUA_REGISTRYINDEX, &fl_traceback_key);
  return 1;
}

static int fl_hostfunction(lua_State *L) {
  int fn = static_cast<int>(lua_tointeger(L, lua_upvalueindex(1)));
  int n = fl_host_call(fl_state(L)->vm, L, fn, lua_gettop(L));
  if (n < 0)
    return lua_error(L);
  return n;
}

static void fl_hook(lua_State *L, lua_Debug *ar) {
  (void)ar;
  if (fl_host_hook(fl_state(L)->vm, L) != 0) {
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
static int fl_require(lua_State *L) {
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

/* Libraries in the order FiveM opens them. */
enum {
  FL_LIB_BASE = 1 << 0,
  FL_LIB_TABLE = 1 << 1,
  FL_LIB_STRING = 1 << 2,
  FL_LIB_MATH = 1 << 3,
  FL_LIB_COROUTINE = 1 << 4,
  FL_LIB_UTF8 = 1 << 5,
  FL_LIB_DEBUG = 1 << 6,
  FL_LIB_MSGPACK = 1 << 7,
  FL_LIB_JSON = 1 << 8,
  FL_LIB_GLM = 1 << 9
};

static const struct {
  int bit;
  const char *name;
  lua_CFunction open;
} fl_libs[] = {
  {FL_LIB_BASE, LUA_GNAME, luaopen_base},
  {FL_LIB_TABLE, LUA_TABLIBNAME, luaopen_table},
  {FL_LIB_STRING, LUA_STRLIBNAME, luaopen_string},
  {FL_LIB_MATH, LUA_MATHLIBNAME, luaopen_math},
  {FL_LIB_COROUTINE, LUA_COLIBNAME, luaopen_coroutine},
  {FL_LIB_UTF8, LUA_UTF8LIBNAME, luaopen_utf8},
  {FL_LIB_DEBUG, LUA_DBLIBNAME, luaopen_debug},
  {FL_LIB_MSGPACK, LUA_MSGPACK_LIBNAME, luaopen_cmsgpack},
  {FL_LIB_JSON, LUA_RAPIDJSON_JSON_LIBNAME, luaopen_rapidjson},
  {FL_LIB_GLM, LUA_GLMLIBNAME, luaopen_glm},
};

static int fl_openlibs_k(lua_State *L) {
  int mask = static_cast<int>(lua_tointeger(L, 1));
  for (const auto &lib : fl_libs) {
    if (mask & lib.bit) {
      luaL_requiref(L, lib.name, lib.open, 1);
      lua_pop(L, 1);
    }
  }
  return 0;
}

static int fl_tostring_k(lua_State *L) {
  luaL_tolstring(L, 1, NULL);
  return 1;
}

/* C functions the host can push by number. */
enum {
  FL_CFUNC_REQUIRE = 1
};

/* }====================================================== */


extern "C" {

/*
** {======================================================
** Lifecycle
** =======================================================
*/

/* Creates a state for VM `vm`, without libraries. Returns NULL when out of memory. */
EMSCRIPTEN_KEEPALIVE lua_State *fl_newstate(int vm) {
  FLState *s = static_cast<FLState *>(malloc(sizeof(FLState)));
  if (s == NULL)
    return NULL;
  s->used = 0;
  s->limit = 0;
  s->vm = vm;
  lua_State *L = lua_newstate(fl_alloc, s);
  if (L == NULL) {
    free(s);
    return NULL;
  }
  lua_atpanic(L, fl_panic);
  lua_setwarnf(L, fl_warn, s);
  lua_gc(L, LUA_GCGEN, 0, 0);  /* FiveM runs its collectors in generational mode */
  return L;
}

EMSCRIPTEN_KEEPALIVE void fl_close(lua_State *L) {
  FLState *s = fl_state(L);
  lua_close(L);
  free(s);
}

/* Protected. Opens the libraries in `mask`; on error leaves the message. */
EMSCRIPTEN_KEEPALIVE int fl_openlibs(lua_State *L, int mask) {
  luaL_checkstack(L, 2, NULL);
  lua_pushcfunction(L, fl_openlibs_k);
  lua_pushinteger(L, mask);
  return lua_pcall(L, 1, 0, 0);
}

EMSCRIPTEN_KEEPALIVE size_t fl_memused(lua_State *L) {
  return fl_state(L)->used;
}

EMSCRIPTEN_KEEPALIVE size_t fl_getmemlimit(lua_State *L) {
  return fl_state(L)->limit;
}

EMSCRIPTEN_KEEPALIVE void fl_setmemlimit(lua_State *L, size_t limit) {
  fl_state(L)->limit = limit;
}

EMSCRIPTEN_KEEPALIVE int fl_gc(lua_State *L, int what, int arg) {
  return lua_gc(L, what, arg);
}

/* Count hook every `count` instructions, inherited by new threads. */
EMSCRIPTEN_KEEPALIVE void fl_sethook(lua_State *L, int count) {
  if (count > 0)
    lua_sethook(L, fl_hook, LUA_MASKCOUNT, count);
  else
    lua_sethook(L, NULL, 0, 0);
}

EMSCRIPTEN_KEEPALIVE uintptr_t fl_stacksave(void) {
  return emscripten_stack_get_current();
}

EMSCRIPTEN_KEEPALIVE void fl_stackrestore(uintptr_t sp) {
  _emscripten_stack_restore(sp);
}

/* }====================================================== */


/*
** {======================================================
** Stack
** =======================================================
*/

EMSCRIPTEN_KEEPALIVE int fl_gettop(lua_State *L) {
  return lua_gettop(L);
}

EMSCRIPTEN_KEEPALIVE void fl_settop(lua_State *L, int idx) {
  lua_settop(L, idx);
}

EMSCRIPTEN_KEEPALIVE void fl_pushvalue(lua_State *L, int idx) {
  luaL_checkstack(L, 1, NULL);
  lua_pushvalue(L, idx);
}

EMSCRIPTEN_KEEPALIVE int fl_type(lua_State *L, int idx) {
  return lua_type(L, idx);
}

/* }====================================================== */


/*
** {======================================================
** Push
** =======================================================
*/

EMSCRIPTEN_KEEPALIVE void fl_pushnil(lua_State *L) {
  luaL_checkstack(L, 1, NULL);
  lua_pushnil(L);
}

EMSCRIPTEN_KEEPALIVE void fl_pushboolean(lua_State *L, int b) {
  luaL_checkstack(L, 1, NULL);
  lua_pushboolean(L, b);
}

/* `n` is integral; the host passes doubles to avoid BigInt conversions. */
EMSCRIPTEN_KEEPALIVE void fl_pushinteger(lua_State *L, double n) {
  luaL_checkstack(L, 1, NULL);
  lua_pushinteger(L, static_cast<lua_Integer>(n));
}

EMSCRIPTEN_KEEPALIVE void fl_pushinteger64(lua_State *L, int64_t n) {
  luaL_checkstack(L, 1, NULL);
  lua_pushinteger(L, static_cast<lua_Integer>(n));
}

EMSCRIPTEN_KEEPALIVE void fl_pushnumber(lua_State *L, double n) {
  luaL_checkstack(L, 1, NULL);
  lua_pushnumber(L, static_cast<lua_Number>(n));
}

EMSCRIPTEN_KEEPALIVE void fl_pushlstring(lua_State *L, const char *s, size_t len) {
  luaL_checkstack(L, 1, NULL);
  lua_pushlstring(L, s, len);
}

/* `kind` is 2, 3 or 4 for vectors and 5 for quaternions. */
EMSCRIPTEN_KEEPALIVE void fl_pushvector(lua_State *L, int kind, float x, float y, float z, float w) {
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
EMSCRIPTEN_KEEPALIVE void fl_pushhostfunction(lua_State *L, int fn) {
  luaL_checkstack(L, 1, NULL);
  lua_pushinteger(L, fn);
  lua_pushcclosure(L, fl_hostfunction, 1);
}

EMSCRIPTEN_KEEPALIVE void fl_pushcfunction(lua_State *L, int which) {
  luaL_checkstack(L, 1, NULL);
  switch (which) {
    case FL_CFUNC_REQUIRE:
      lua_pushcfunction(L, fl_require);
      break;
    default:
      lua_pushnil(L);
      break;
  }
}

EMSCRIPTEN_KEEPALIVE void fl_pushglobaltable(lua_State *L) {
  luaL_checkstack(L, 1, NULL);
  lua_pushglobaltable(L);
}

/* }====================================================== */


/*
** {======================================================
** Read
** =======================================================
*/

EMSCRIPTEN_KEEPALIVE int fl_toboolean(lua_State *L, int idx) {
  return lua_toboolean(L, idx);
}

EMSCRIPTEN_KEEPALIVE double fl_tonumber(lua_State *L, int idx) {
  return static_cast<double>(lua_tonumber(L, idx));
}

EMSCRIPTEN_KEEPALIVE int64_t fl_tointeger64(lua_State *L, int idx) {
  return static_cast<int64_t>(lua_tointeger(L, idx));
}

EMSCRIPTEN_KEEPALIVE int fl_isinteger(lua_State *L, int idx) {
  return lua_isinteger(L, idx);
}

/* Converts numbers in place, like lua_tolstring. */
EMSCRIPTEN_KEEPALIVE const char *fl_tolstring(lua_State *L, int idx, size_t *len) {
  return lua_tolstring(L, idx, len);
}

/*
** Writes the components to out[4] and returns the kind (2, 3, 4, or 5 for
** quaternions), or 0 when the value is not a vector.
*/
EMSCRIPTEN_KEEPALIVE int fl_tovector(lua_State *L, int idx, float *out) {
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
EMSCRIPTEN_KEEPALIVE int fl_tostring(lua_State *L, int idx) {
  idx = lua_absindex(L, idx);
  luaL_checkstack(L, 2, NULL);
  lua_pushcfunction(L, fl_tostring_k);
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
EMSCRIPTEN_KEEPALIVE int fl_rawget(lua_State *L, int idx) {
  return lua_rawget(L, idx);
}

/* Pops a key and a value into the table at `idx`, without metamethods. */
EMSCRIPTEN_KEEPALIVE void fl_rawset(lua_State *L, int idx) {
  lua_rawset(L, idx);
}

/* Pops a value and stores it in the registry, returning its reference. */
EMSCRIPTEN_KEEPALIVE int fl_ref(lua_State *L) {
  return luaL_ref(L, LUA_REGISTRYINDEX);
}

EMSCRIPTEN_KEEPALIVE void fl_unref(lua_State *L, int ref) {
  luaL_unref(L, LUA_REGISTRYINDEX, ref);
}

EMSCRIPTEN_KEEPALIVE int fl_getref(lua_State *L, int ref) {
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
EMSCRIPTEN_KEEPALIVE int fl_load(lua_State *L, const char *buf, size_t len, const char *name, const char *mode) {
  luaL_checkstack(L, 1, NULL);
  return luaL_loadbufferx(L, buf, len, name, mode);
}

/*
** Protected. Calls the function below the `nargs` arguments on top of the
** stack. On error, leaves the error object and records a traceback that
** fl_traceback returns.
*/
EMSCRIPTEN_KEEPALIVE int fl_pcall(lua_State *L, int nargs, int nresults) {
  int base = lua_gettop(L) - nargs;
  luaL_checkstack(L, 1, NULL);
  lua_pushcfunction(L, fl_msgh);
  lua_insert(L, base);
  int status = lua_pcall(L, nargs, nresults, base);
  lua_remove(L, base);
  return status;
}

/* Pushes the traceback of the last failed fl_pcall (or nil) and clears it. */
EMSCRIPTEN_KEEPALIVE const char *fl_traceback(lua_State *L, size_t *len) {
  luaL_checkstack(L, 2, NULL);
  lua_rawgetp(L, LUA_REGISTRYINDEX, &fl_traceback_key);
  lua_pushnil(L);
  lua_rawsetp(L, LUA_REGISTRYINDEX, &fl_traceback_key);
  return lua_tolstring(L, -1, len);
}

/* }====================================================== */

}
