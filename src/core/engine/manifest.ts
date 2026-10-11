import { LuaError, LuaLib, LuaRef, type LuaRuntime } from '../lua/index.ts'
import manifestSource from './lua/manifest.lua?raw'

/** Where a manifest defined an entry, as FiveM records it. */
export interface MetadataLocation {
  /** The manifest's path, for an entry a file defined. */
  readonly file: string
  readonly line: number
}

/** An entry of a resource manifest, such as ['client_script', 'client.lua']. */
export type MetadataEntry = readonly [key: string, value: string, location?: MetadataLocation]

/** Why a resource's manifest did not load, in FiveM's words. */
export class ManifestError extends Error {
  override readonly name = 'ManifestError'
  /** Whether the resource has no manifest at all, which FiveM's server only warns about. */
  readonly missing: boolean

  constructor(message: string, missing = false) {
    super(message)
    this.missing = missing
  }
}

/** The libraries FiveM opens for manifests: its scripts' but msgpack. */
const MANIFEST_LIBS =
  LuaLib.base |
  LuaLib.table |
  LuaLib.string |
  LuaLib.math |
  LuaLib.debug |
  LuaLib.coroutine |
  LuaLib.utf8 |
  LuaLib.json

/** The manifests FiveM looks for, in order. */
const MANIFEST_FILES = ['fxmanifest.lua', '__resource.lua']

/**
 * Reads the manifest of the resource at `path` as FiveM does: it runs its
 * fxmanifest.lua, or else its __resource.lua, in a Lua state of its own, and
 * returns the entries it adds. An fxmanifest.lua adds is_cfxv2 too, which
 * manifests cannot add themselves.
 *
 * Throws a ManifestError when the manifest does not load.
 */
export function readManifest(
  lua: LuaRuntime,
  path: string,
  file: (path: string) => string | Uint8Array | undefined,
): MetadataEntry[] {
  const entries: MetadataEntry[] = []
  const state = lua.newState({ libs: MANIFEST_LIBS })
  try {
    const add = state.hostFunction((args) => {
      const key = String(args.get(1))
      if (key.toLowerCase() === 'is_cfxv2') return
      const value = String(args.get(2))
      const source = args.get(3)
      if (typeof source !== 'string') {
        entries.push([key, value])
        return
      }
      // FiveM puts the resource's path before the chunk names of files.
      const where = source.startsWith('@') ? `${path}/${source.slice(1)}` : String(args.get(4))
      entries.push([key, value, { file: where, line: Number(args.get(5)) }])
    })
    const [init] = state.run(manifestSource, '@fivelab:/manifest.lua', add)
    if (!(init instanceof LuaRef)) throw new Error('The manifest prelude did not return a function')
    for (const name of ['dofile', 'load', 'loadfile']) state.setGlobal(name, null)
    for (const name of MANIFEST_FILES) {
      const source = file(name)
      if (source === undefined) continue
      const filename = `${path}/${name}`
      let chunk
      try {
        chunk = state.load(source, `@${lastTwo(filename)}`)
      } catch (error) {
        throw new ManifestError(
          `Could not parse resource metadata file ${filename}: ${messageOf(error)}`,
        )
      }
      try {
        state.call(init, chunk)
      } catch (error) {
        const traceback = error instanceof LuaError ? error.luaTraceback : undefined
        throw new ManifestError(
          `Could not execute resource metadata file ${filename}: ${messageOf(error)}` +
            (traceback === undefined ? '' : `\n${traceback}`),
        )
      } finally {
        chunk.release()
      }
      if (name === 'fxmanifest.lua') entries.push(['is_cfxv2', 'true'])
      return entries
    }
    throw new ManifestError('Could not open resource metadata file - no such file.', true)
  } finally {
    state.close()
  }
}

/** The last two parts of a path, which FiveM names manifest chunks after. */
function lastTwo(filename: string): string {
  const last = filename.lastIndexOf('/')
  if (last <= 0) return filename
  const secondLast = filename.lastIndexOf('/', last - 1)
  return secondLast === -1 ? filename : filename.slice(secondLast + 1)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
