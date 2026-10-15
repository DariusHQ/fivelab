import {
  VariableFlags,
  type NamedType,
  type Variable,
  type VariableType,
  type VariableValue,
} from '../console/index.ts'
import { atoi, stricmpKey } from '../libc.ts'
import { DEFAULT_GAME_BUILD, FIVEM_BUILD, FIVEM_VERSION, parseGameBuild } from './constraints.ts'
import type { ResourceManager } from './manager.ts'

/** A type of FiveM's of names, which the names in `names` stand for, whatever their case. */
function named(name: string, names: Readonly<Record<string, string>>): NamedType {
  return { name, parse: (text) => names[stricmpKey(text)] }
}

/** FiveM's fx::GameName: the game that a server runs. */
export const GAME_NAME = named('fx::GameName', { gta4: 'gta4', gta5: 'gta5', rdr3: 'rdr3' })

/** FiveM's fx::OneSyncState: whether OneSync is on, which true and false say too. */
export const ONESYNC_STATE = named('fx::OneSyncState', {
  on: 'on',
  true: 'on',
  legacy: 'legacy',
  off: 'off',
  false: 'off',
})

/** FiveM's fx::EntityLockdownMode: which entities clients may create. */
export const ENTITY_LOCKDOWN_MODE = named('fx::EntityLockdownMode', {
  strict: 'strict',
  no_dummy: 'no_dummy',
  relaxed: 'relaxed',
  inactive: 'inactive',
  false: 'inactive',
  off: 'inactive',
})

/** FiveM's fx::GameBuild: a game build, by its number, which the names of updates stand for too. */
export const GAME_BUILD: NamedType = {
  name: 'fx::GameBuild',
  parse: (text) => {
    const build = parseGameBuild(text)
    return build === undefined ? undefined : String(build)
  },
}

/** How many clients FiveM's servers take at most, which sv_maxClients is at most. */
const MAX_CLIENTS = 2048 + 1

/** The port that FiveM's servers take an endpoint at unless it names one. */
const DEFAULT_PORT = 30120

type Definition = readonly [name: string, flags: number, type: VariableType, value: VariableValue]

const { none, serverInfo, replicated, readOnly, internal } = VariableFlags

/**
 * The variables that FiveM's server defines on the default context of its
 * console, rather than its own, which scripts do not read, though the
 * console that falls back to it has their commands.
 */
const DEFAULT_CONTEXT: readonly Definition[] = [
  ['gamename', serverInfo, GAME_NAME, 'gta5'],
  ['sv_httpHandlerConnectionTimeoutSeconds', none, 'uint16', 300],
]

/**
 * The variables that FiveM's server defines as it starts, before its
 * configuration runs, as its components add them, with their defaults.
 * Those of the game, the network and the HTTP server are there, though
 * FiveRunner does nothing with most of them: scripts and configurations
 * read and set them all the same.
 */
const DEFINITIONS: readonly Definition[] = [
  // The game server.
  ['rcon_password', readOnly, 'string', ''],
  ['sv_playersToken', none, 'string', ''],
  ['sv_profileDataToken', none, 'string', ''],
  ['sv_hostname', serverInfo, 'string', 'default FXServer'],
  ['sv_master1', none, 'string', 'https://servers-frontend.fivem.net/api/serverlist/ingress'],
  ['sv_master2', none, 'string', ''],
  ['sv_master3', none, 'string', ''],
  ['sv_listingIpOverride', none, 'string', ''],
  ['sv_useAccurateSends', none, 'bool', true],
  ['sv_forceIndirectListing', none, 'bool', false],
  ['sv_listingHostOverride', none, 'string', ''],
  ['netlib', none, 'string', 'enet'],
  ['sv_returnClientsListInGetStatus', none, 'bool', true],
  ['sv_enableGetStatus', none, 'bool', false],
  // What the server says of itself.
  ['sv_infoVersion', serverInfo, 'int', 0],
  ['sv_maxClients', serverInfo, 'int', 30],
  ['sv_icon', internal, 'string', ''],
  ['version', internal, 'string', FIVEM_VERSION],
  ['buildNumber', internal, 'int', FIVEM_BUILD],
  ['sv_requestParanoia', none, 'int', 0],
  ['sv_endpointPrivacy', none, 'bool', false],
  ['sv_exposePlayerIdentifiersInHttpEndpoint', none, 'bool', false],
  // How players connect.
  ['sv_authMinTrust', none, 'int', 1],
  ['sv_authMaxVariance', none, 'int', 5],
  ['sv_pureLevel', serverInfo, 'int', 0],
  ['sv_scriptHookAllowed', serverInfo, 'bool', false],
  ['sv_enhancedHostSupport', serverInfo, 'bool', false],
  ['sv_endpoints', none, 'string', ''],
  ['sv_lan', serverInfo, 'bool', false],
  ['sv_enforceGameBuild', readOnly | serverInfo, GAME_BUILD, String(DEFAULT_GAME_BUILD)],
  ['sv_defaultGameBuild', internal | serverInfo, 'string', String(DEFAULT_GAME_BUILD)],
  ['sv_replaceExeToSwitchBuilds', internal | serverInfo, 'bool', false],
  ['sv_poolSizesIncrease', serverInfo | internal, 'string', ''],
  ['steam_webApiKey', none, 'string', ''],
  ['steam_webApiDomain', none, 'string', 'api.steampowered.com'],
  ['sv_enforceSteamAuth', serverInfo, 'bool', false],
  // The HTTP and TCP servers.
  ['sv_threadedClientHttp', none, 'bool', true],
  ['sv_maxClientEndpointRequestSize', none, 'int', 1024 * 100],
  ['sv_httpFileServerProxyOnly', none, 'bool', false],
  ['sv_prometheusBasicAuthUser', none, 'string', ''],
  ['sv_prometheusBasicAuthPassword', none, 'string', ''],
  ['sv_netHttp2', none, 'bool', false],
  ['netPort', none, 'int', 0],
  ['net_tcpConnLimit', none, 'int', 16],
  ['sv_registerMulticastDns', none, 'bool', true],
  ['sv_tcpConnectionTimeoutSeconds', none, 'uint16', 5],
  ['sv_tebexSecret', none, 'string', ''],
  // Events.
  ['sv_netEventReassemblyMaxPendingEvents', none, 'uint16', 100],
  ['sv_netEventReassemblyUnlimitedPendingEvents', none, 'bool', false],
  // The state of the game.
  ['sv_entityLockdown', none, ENTITY_LOCKDOWN_MODE, 'inactive'],
  ['sv_enableNetworkedSounds', none, 'bool', true],
  ['sv_enableNetworkedPhoneExplosions', none, 'bool', false],
  ['sv_protectServerEntities', replicated, 'bool', false],
  ['sv_enableNetworkedScriptEntityStates', none, 'bool', true],
  ['sv_filterRequestControl', none, 'int', 0],
  ['sv_filterRequestControlSettleTimer', none, 'int', 30000],
  // OneSync.
  ['onesync_enabled', serverInfo | internal, 'bool', false],
  ['onesync_distanceCulling', none, 'bool', true],
  ['onesync_distanceCullVehicles', none, 'bool', false],
  ['onesync_forceMigration', none, 'bool', true],
  ['onesync_radiusFrequency', none, 'bool', true],
  ['onesync_logFile', none, 'string', ''],
  ['onesync_workaround763185', none, 'bool', false],
  ['onesync', internal, ONESYNC_STATE, 'on'],
  ['onesync_population', readOnly, 'bool', true],
  ['onesync_automaticResend', none, 'bool', false],
  ['onesync_enableInfinity', internal, 'bool', true],
  ['onesync_enableBeyond', internal, 'bool', true],
]

/** The ranges of the variables whose values FiveM limits. */
const RANGES: readonly (readonly [name: string, min: number, max: number])[] = [
  ['sv_maxClients', 1, MAX_CLIENTS],
  ['sv_authMinTrust', 1, 5],
  ['sv_authMaxVariance', 1, 5],
]

/**
 * Defines the variables of FiveM's server on the consoles of a server, as
 * it starts with OneSync and `gameBuild` as the process has them, as its
 * command line would set them, and adds the commands of its endpoints:
 * which FiveRunner listens at none of, though the first that takes TCP sets
 * netPort, the primary port, as in FiveM.
 */
export function defineServerVariables(
  manager: ResourceManager,
  gameBuild: number,
): ServerEndpoints {
  const { variables, commands } = manager.console
  for (const [name, flags, type, value] of DEFAULT_CONTEXT) {
    manager.defaultConsole.variables.define(name, flags, type, value)
  }
  const defined = new Map<string, Variable>()
  for (const [name, flags, type, value] of DEFINITIONS) {
    defined.set(name, variables.define(name, flags, type, value))
  }
  for (const [name, min, max] of RANGES) defined.get(name)!.setRange(min, max)
  if (!manager.oneSync) defined.get('onesync')!.setRaw('off')
  defined.get('sv_enforceGameBuild')!.setRaw(String(gameBuild))
  const endpoints: ServerEndpoints = { primaryPort: 0 }
  const netPort = defined.get('netPort')!
  commands.add('endpoint_add_tcp', ['string'], (endpoint) => {
    const port = portOf(endpoint)
    if (endpoints.primaryPort === 0) {
      endpoints.primaryPort = port
      netPort.setRaw(port)
    }
  })
  commands.add('endpoint_add_udp', ['string'], () => {})
  return endpoints
}

/** What FiveM's server keeps of its endpoints. */
export interface ServerEndpoints {
  /** The port of the first endpoint for TCP, or 0 before there is one, as FiveM's GetPrimaryPort gives it. */
  primaryPort: number
}

/**
 * The port of an endpoint, as FiveM's PeerAddress reads it: after its last
 * colon, unless that is within the brackets of an IPv6 address, or 30120.
 */
export function portOf(endpoint: string): number {
  const colon = endpoint.lastIndexOf(':')
  if (colon === -1 || colon < endpoint.lastIndexOf(']')) return DEFAULT_PORT
  // FiveM keeps the port in 16 bits.
  return atoi(endpoint.slice(colon + 1)) & 0xffff
}

/**
 * What FiveM's server does with its variables once its configuration ran:
 * OneSync that is on enables onesync_enabled, and the variables it no
 * longer uses warn when they are set. It also adds con_disableNonTTYReads
 * then, as its terminal does.
 */
export function configureServerVariables(manager: ResourceManager): void {
  const { variables } = manager.console
  if (variables.find('onesync')!.value !== 'off') variables.find('onesync_enabled')!.setRaw(true)
  if (variables.find('sv_endpointPrivacy')!.rawValue === true) {
    manager.printer.printWarning(
      'server',
      '`sv_endpointPrivacy` has been removed. Player endpoint addresses are no longer exposed on any HTTP endpoint. Please remove this ConVar from your server configuration.\n',
    )
  }
  if (variables.find('sv_exposePlayerIdentifiersInHttpEndpoint')!.rawValue === true) {
    manager.printer.printWarning(
      'server',
      '`sv_exposePlayerIdentifiersInHttpEndpoint` has been removed. Player names and identifiers are only exposed on `/players.json` when the request is authenticated via `sv_playersToken` (using the `X-Players-Token` header or `?token=` query parameter). Please remove this ConVar from your server configuration.\n',
    )
  }
  variables.define('con_disableNonTTYReads', VariableFlags.none, 'bool', false)
}
