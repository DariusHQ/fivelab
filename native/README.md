# CfxLua for WebAssembly

FiveLab runs Lua with the same runtime FiveM ships: CfxLua, Lua 5.4 with the LuaGLM
extensions (vectors, quaternions, matrices, compound operators, safe navigation and the
rest), plus the `msgpack` and `json` libraries FiveM opens in every script. This
directory compiles that runtime to `src/core/lua/cfxlua.wasm`.

- `vendor/` holds the sources as git submodules, pinned to the commits FiveM uses.
- `fivelab.cpp` is a small C ABI that the TypeScript side (`src/core/lua`) calls.

The compiled module is committed, so working on FiveLab does not need any of this.

## Building

You need the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
at version 6.0.10, the version CI uses, and the submodules:

```bash
git submodule update --init
```

```bash
emsdk install 6.0.10
```

```bash
emsdk activate 6.0.10
```

Then, in a shell where `emsdk_env` has run (it sets `EMSDK`):

```bash
npm run build:wasm
```

The build is deterministic: the same sources and Emscripten version give the same bytes
on every platform, and CI rebuilds the module to check that the committed one matches.

## Configuration

`scripts/build-wasm.ts` uses the defines from FiveM's `vendor/lua.lua`, with these
differences:

- No `GLM_FORCE_SSE2` or `GLM_FORCE_DEFAULT_ALIGNED_GENTYPES`. WebAssembly has no x86
  SIMD, so GLM uses its portable code paths.
- No `GRIT_POWER_CHRONO`. It only adds x86 timers to Lua's stock `os` library, which FiveM
  does not open.
- No profiler (`lmprof`) and no `NOMINMAX`.
- `LUA_USE_LONGJMP`, as in FiveM's Windows build. Lua errors unwind with WebAssembly
  exception handling, which also carries them through JavaScript frames.
- lua-cmsgpack is built with `__WINDOWS__`: it has no Emscripten case for the byte order
  of vector components, and its Windows case packs them little-endian, as FiveM does.
- lua-cmsgpack is built with `cmsgpack64.h` included first. It takes a target with 32-bit
  pointers for a 32-bit Lua and would pack integers in 32 bits and floats as singles, where
  FiveM's 64-bit builds pack them in full.
- lua-rapidjson is built with `_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION`, since
  libc++ removed `std::unary_function` in C++17 and MSVC still provides it.

## Known differences from FiveM

- Floating-point results of math functions can differ from Windows in the last bits, since
  they come from musl instead of the MSVC runtime. `tostring(0/0)` prints `-nan`, as on a
  Linux server, where the Windows client prints `-nan(ind)`.
- `require('lmprof')` fails: the profiler is not included.

## Updating the pins

FiveM records the commits as submodules of [citizenfx/fivem](https://github.com/citizenfx/fivem).
To read the current one for a library:

```bash
gh api repos/citizenfx/fivem/contents/vendor/lua --jq .sha
```

The paths are `vendor/lua`, `vendor/glm`, `vendor/lua-cmsgpack`, `vendor/msgpack-c`,
`vendor/lua-rapidjson` and `vendor/rapidjson`. Check out the new commit in the matching
submodule here:

```bash
git -C native/vendor/lua fetch --depth 1 origin <sha>
```

```bash
git -C native/vendor/lua checkout <sha>
```

Then rebuild, run `npm test`, compare FiveM's `vendor/lua.lua` with the defines in
`scripts/build-wasm.ts`, and commit the new pins together with the rebuilt module.
