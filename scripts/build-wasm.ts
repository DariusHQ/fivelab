/**
 * Compiles CfxLua, FiveM's Lua 5.4 runtime, together with its msgpack and json
 * libraries and the FiveLab bridge (native/fivelab.cpp) to WebAssembly.
 *
 *   node scripts/build-wasm.ts
 *
 * Needs the Emscripten SDK (EMSDK set, as emsdk_env does) and the
 * native/vendor submodules. The output is committed, so only run this after
 * changing the bridge, the flags or the vendored sources.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Runs a command in the repository root, printing its output if it fails. */
async function run(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string }
    process.stderr.write(`${stdout ?? ''}${stderr ?? ''}`)
    throw new Error(`Command failed: ${[command, ...args].join(' ')}`, { cause: error })
  }
}

const root = resolve(import.meta.dirname, '..')
const vendor = 'native/vendor'
const build = 'native/build'
const output = 'src/core/lua/cfxlua.wasm'

/**
 * FiveM's defines for its Lua 5.4 runtime (vendor/lua.lua in citizenfx/fivem),
 * minus the profiler, NOMINMAX and the x86 SIMD flags. GRIT_POWER_CHRONO is
 * left out too: it only adds x86 timers to Lua's stock os library, which FiveM
 * replaces with its own. LUA_USE_LONGJMP is what the Windows build uses; here
 * longjmp runs on WebAssembly exceptions.
 */
const defines = [
  'MAKE_LIB',
  'LUA_USE_LONGJMP',
  'LUA_COMPAT_5_3',
  'LUA_SANDBOX',
  'LUA_C99_MATHLIB',
  'GRIT_POWER_COMPOUND',
  'GRIT_POWER_INTABLE',
  'GRIT_POWER_TABINIT',
  'GRIT_POWER_SAFENAV',
  'GRIT_POWER_CCOMMENT',
  'GRIT_POWER_DEFER_OLD',
  'GRIT_POWER_JOAAT',
  'GRIT_POWER_EACH',
  'GRIT_POWER_WOW',
  'GRIT_COMPAT_IPAIRS',
  'GRIT_POWER_BLOB',
  'GLM_ENABLE_EXPERIMENTAL',
  'GLM_FORCE_INLINE',
  'GLM_FORCE_Z_UP',
  'LUA_GLM_INCLUDE_ALL',
  'LUA_GLM_ALIASES',
  'LUA_GLM_GEOM_EXTENSIONS',
  'LUA_GLM_RECYCLE',
  'LUA_INCLUDE_LIBGLM',
  'LUA_COMPILED_AS_HPP',
  'LUACMSGPACK_COMPAT',
  'LUA_RAPIDJSON_SANITIZE_KEYS',
  'LUA_RAPIDJSON_ALLOCATOR',
  'MSGPACK_DLLEXPORT=',
  'NDEBUG',
]

const includes = [
  `${vendor}/lua`,
  `${vendor}/lua/libs/glm-binding`,
  `${vendor}/glm`,
  `${vendor}/lua-cmsgpack/src`,
  `${vendor}/lua-rapidjson/src`,
  `${vendor}/rapidjson/include`,
  `${vendor}/msgpack-c/include`,
  `${build}/gen`,
  `${build}/gen/msgpack`,
]

/** Warnings are silenced for vendored sources; ours must compile cleanly. */
const sources: { file: string; flags: string[] }[] = [
  { file: `${vendor}/lua/onelua.c`, flags: ['-w'] },
  // lua-cmsgpack picks the byte order of vector components per platform and has
  // no Emscripten case. Its Windows branch packs them little-endian, like FiveM.
  { file: `${vendor}/lua-cmsgpack/src/lua_cmsgpack.c`, flags: ['-w', '-D__WINDOWS__'] },
  // lua-rapidjson derives from std::unary_function, which libc++ drops in C++17.
  {
    file: `${vendor}/lua-rapidjson/src/lua_rapidjson.cpp`,
    flags: ['-w', '-D_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION'],
  },
  ...['objectc', 'unpack', 'version', 'vrefbuffer', 'zone'].map((name) => ({
    file: `${vendor}/msgpack-c/src/${name}.c`,
    flags: ['-w'],
  })),
  { file: 'native/fivelab.cpp', flags: ['-Wall', '-Wextra', '-Werror'] },
]

const optimize = '-O2'

function objectFile(source: string): string {
  return `${build}/obj/${source.replaceAll('/', '_')}.o`
}

function emscripten(): { command: string; prefix: string[]; sdk: string } {
  const sdk = process.env.EMSDK
  if (!sdk) {
    throw new Error('EMSDK is not set. Install the Emscripten SDK and run emsdk_env first.')
  }
  const script = join(sdk, 'upstream', 'emscripten', 'em++.py')
  if (!existsSync(script)) throw new Error(`em++ not found at ${script}`)
  const python = process.env.EMSDK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  return { command: python, prefix: [script], sdk }
}

/** msgpack-c configures two headers with CMake; only the byte order is substituted. */
function generateMsgpackHeaders(): void {
  const dir = join(root, build, 'gen', 'msgpack')
  mkdirSync(dir, { recursive: true })
  for (const name of ['sysdep.h', 'pack_template.h']) {
    const template = readFileSync(join(root, vendor, 'msgpack-c', 'cmake', `${name}.in`), 'utf8')
    const header = template
      .replaceAll('@MSGPACK_ENDIAN_BIG_BYTE@', '0')
      .replaceAll('@MSGPACK_ENDIAN_LITTLE_BYTE@', '1')
    if (/@\w+@/.test(header)) throw new Error(`Unexpected placeholder in ${name}.in`)
    writeFileSync(join(dir, name), header)
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(root, vendor, 'lua', 'onelua.c'))) {
    throw new Error('Vendored sources are missing. Run: git submodule update --init')
  }
  const em = emscripten()
  generateMsgpackHeaders()

  const common = [
    optimize,
    '-std=c++17',
    '-fwasm-exceptions',
    `-ffile-prefix-map=${root}=.`,
    `-ffile-prefix-map=${em.sdk}=/emsdk`,
  ]
  mkdirSync(join(root, build, 'obj'), { recursive: true })

  await Promise.all(
    sources.map(async ({ file, flags }) => {
      await run(em.command, [
        ...em.prefix,
        ...common,
        ...flags,
        ...defines.map((define) => `-D${define}`),
        ...includes.map((dir) => `-I${dir}`),
        '-x',
        'c++',
        '-c',
        file,
        '-o',
        objectFile(file),
      ])
      console.log(`compiled ${file}`)
    }),
  )

  await run(em.command, [
    ...em.prefix,
    ...common,
    '-sSTANDALONE_WASM=1',
    '--no-entry',
    '-sWASM_LEGACY_EXCEPTIONS=1',
    '-sSUPPORT_LONGJMP=wasm',
    '-sALLOW_MEMORY_GROWTH=1',
    `-sINITIAL_MEMORY=${4 * 1024 * 1024}`,
    `-sMAXIMUM_MEMORY=${2 * 1024 * 1024 * 1024}`,
    `-sSTACK_SIZE=${1024 * 1024}`,
    '-sABORTING_MALLOC=0',
    '-sFILESYSTEM=0',
    '-sEXPORTED_FUNCTIONS=_malloc,_free',
    ...sources.map(({ file }) => objectFile(file)),
    '-o',
    output,
  ])
  // Emscripten marks its output executable on POSIX systems; git records that.
  chmodSync(join(root, output), 0o644)

  const wasm = readFileSync(join(root, output))
  const sha256 = createHash('sha256').update(wasm).digest('hex')
  console.log(`${output}: ${(wasm.length / 1024).toFixed(0)} KiB, sha256 ${sha256}`)
}

await main()
