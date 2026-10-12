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

/** The versions of fxmanifest.lua that FiveM knows, oldest first, after none. */
const FX_VERSIONS = ['', 'adamant', 'bodacious', 'cerulean']

/**
 * Whether a manifest's fx_version, its first, is `version` or later, as
 * FiveM compares them. Like FiveM's server, it takes versions that FiveM
 * does not know as none.
 */
export function isFxVersionAtLeast(metadata: readonly MetadataEntry[], version: string): boolean {
  const own = FX_VERSIONS.indexOf(metadata.find(([key]) => key === 'fx_version')?.[1] ?? '')
  return own !== -1 && own >= FX_VERSIONS.indexOf(version)
}

/**
 * Entries that FiveM reads, by the plural names that manifests give them.
 * Given a table, such a name adds entries without its final s, which FiveM
 * reads, but given a string, it adds one by that name, which FiveM does not.
 */
const PLURALS = new Map([
  ['client_scripts', 'client_script'],
  ['server_scripts', 'server_script'],
  ['shared_scripts', 'shared_script'],
  ['files', 'file'],
  ['exports', 'export'],
  ['server_exports', 'server_export'],
  ['dependencies', 'dependency'],
  ['provides', 'provide'],
  ['games', 'game'],
])

/**
 * The entries of a manifest that have the plural name of entries that FiveM
 * reads, which it does not read, with the singular name.
 */
export function pluralEntries(
  metadata: readonly MetadataEntry[],
): (readonly [entry: MetadataEntry, singular: string])[] {
  return metadata.flatMap((entry) => {
    const singular = PLURALS.get(entry[0])
    return singular === undefined ? [] : [[entry, singular] as const]
  })
}

/** The versions of __resource.lua that FiveM knows, in its order, after none. */
const MANIFEST_VERSIONS = [
  '00000000-0000-0000-0000-000000000000',
  '77731fab-63ca-442c-a67b-abc70f28dfa5',
  'f15e72ec-3972-4fe4-9c7d-afc5394ae207',
  '44febabe-d386-4d18-afbe-5e627f4af937',
  '05cfa83c-a124-4cfa-a768-c24a5811d8f9',
]

/** The natives of FiveM's GTA V clients, with the manifest versions they start at, oldest first. */
const CLIENT_NATIVES = [
  ['natives_21e43a33.lua', MANIFEST_VERSIONS[0]!],
  ['natives_0193d0af.lua', 'f15e72ec-3972-4fe4-9c7d-afc5394ae207'],
  ['natives_universal.lua', '44febabe-d386-4d18-afbe-5e627f4af937'],
] as const

/**
 * A manifest version as FiveM parses guids: the 36 characters it starts
 * with, in hex digits of either case and dashes, or else none.
 */
function parseManifestVersion(value: string): string {
  const guid = value.slice(0, 36)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid)
    ? guid.toLowerCase()
    : MANIFEST_VERSIONS[0]!
}

/**
 * The file of natives that FiveM's GTA V client gives the scripts of a
 * resource, by its manifest: natives_universal.lua for an fx_version, its
 * first, of adamant or later, and otherwise the newest whose version its
 * resource_manifest_version, its first, has reached. Like FiveM, it gives
 * natives_21e43a33.lua for versions that FiveM does not know.
 */
export function clientNativesFile(metadata: readonly MetadataEntry[]): string {
  if (isFxVersionAtLeast(metadata, 'adamant')) return 'natives_universal.lua'
  const value = metadata.find(([key]) => key === 'resource_manifest_version')?.[1]
  // An unknown version, at -1, has reached none.
  const own = MANIFEST_VERSIONS.indexOf(parseManifestVersion(value ?? ''))
  let file: string = CLIENT_NATIVES[0][0]
  for (const [natives, since] of CLIENT_NATIVES) {
    if (own >= MANIFEST_VERSIONS.indexOf(since)) file = natives
  }
  return file
}

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
