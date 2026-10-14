import { describe, expect, it } from 'vitest'

import { VariableFlags, type Variables } from '../../src/core/console/index.ts'
import { GAME_BUILD, GAME_NAME, ONESYNC_STATE, portOf } from '../../src/core/engine/builtins.ts'
import { createProcess, runCommand, startResource } from './helpers.ts'

/** What the command of a variable's name says of it. */
function describeVariable(
  name: string,
  value: string,
  fallback: string,
  flags: string,
  type: string,
) {
  return [
    ` "${name}" is "${value}"`,
    ` default: "${fallback}" - flags( ${flags})`,
    ` type: ${type}`,
  ].map((line) => `[cmd] ${line}`)
}

describe('The variables of servers', () => {
  it('are those of FiveM, with their types, flags and defaults', async () => {
    const proc = await createProcess()
    const names = [
      'sv_maxClients',
      'sv_hostname',
      'onesync',
      'sv_enforceGameBuild',
      'sv_netEventReassemblyMaxPendingEvents',
      'sv_entityLockdown',
      'sv_protectServerEntities',
      'version',
      'gamename',
    ]
    for (const name of names) runCommand(proc.manager, name, 'system.console')
    expect(proc.take()).toEqual([
      ...describeVariable('sv_maxClients', '30', '30', 'ServerInfo ', 'int'),
      ...describeVariable(
        'sv_hostname',
        'default FXServer',
        'default FXServer',
        'ServerInfo ',
        'string',
      ),
      ...describeVariable('onesync', 'on', 'on', 'Internal ', 'fx::OneSyncState'),
      ...describeVariable(
        'sv_enforceGameBuild',
        '3258',
        '3258',
        'ServerInfo ReadOnly ',
        'fx::GameBuild',
      ),
      ...describeVariable(
        'sv_netEventReassemblyMaxPendingEvents',
        '100',
        '100',
        '',
        'unsigned short',
      ),
      ...describeVariable(
        'sv_entityLockdown',
        'inactive',
        'inactive',
        '',
        'fx::EntityLockdownMode',
      ),
      ...describeVariable('sv_protectServerEntities', 'false', 'false', 'Replicated ', 'bool'),
      ...describeVariable(
        'version',
        'FXServer-master SERVER v1.0.0.37175 win32',
        'FXServer-master SERVER v1.0.0.37175 win32',
        'Internal ',
        'string',
      ),
      ...describeVariable('gamename', 'gta5', 'gta5', 'ServerInfo ', 'fx::GameName'),
    ])
  })

  it('give scripts their values, but those of the default console, such as gamename', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(GetConvar('sv_maxclients', 'x'), GetConvarInt('sv_maxClients', 0), GetConvar('onesync', 'x'))
print(GetConvar('gamename', 'none'), GetConvar('buildNumber', ''), GetConvar('sv_httpHandlerConnectionTimeoutSeconds', 'none'))`,
      }),
    ).toEqual(['[script:a] 30\t30\ton', '[script:a] none\t37175\tnone'])
  })

  it('take OneSync and the enforced game build as the command line of the process sets them', async () => {
    const proc = await createProcess({ oneSync: false, gameBuild: 2944 })
    for (const name of ['onesync', 'sv_enforceGameBuild']) {
      runCommand(proc.manager, name, 'system.console')
    }
    proc.manager.endInitialConfiguration()
    expect([proc.take(), proc.manager.console.variables.find('onesync_enabled')?.value]).toEqual([
      [
        ...describeVariable('onesync', 'off', 'on', 'Modified Internal ', 'fx::OneSyncState'),
        ...describeVariable(
          'sv_enforceGameBuild',
          '2944',
          '3258',
          'Modified ServerInfo ReadOnly ',
          'fx::GameBuild',
        ),
      ],
      'false',
    ])
  })

  it('enable onesync_enabled once configured with OneSync, and add con_disableNonTTYReads then', async () => {
    const proc = await createProcess()
    const { variables } = proc.manager.console
    const before = [
      variables.find('onesync_enabled')?.value,
      variables.find('con_disableNonTTYReads'),
    ]
    proc.manager.endInitialConfiguration()
    expect([
      before,
      variables.find('onesync_enabled')?.value,
      variables.find('con_disableNonTTYReads')?.value,
    ]).toEqual([['false', undefined], 'true', 'false'])
  })

  it('warn of the variables FiveM no longer uses, once configured with them', async () => {
    const proc = await createProcess()
    runCommand(proc.manager, 'set sv_endpointPrivacy true', 'system.console')
    runCommand(proc.manager, 'set sv_exposePlayerIdentifiersInHttpEndpoint 1', 'system.console')
    proc.manager.endInitialConfiguration()
    expect(proc.take()).toEqual([
      '[server] ^3Warning: `sv_endpointPrivacy` has been removed. Player endpoint addresses are no longer exposed on any HTTP endpoint. Please remove this ConVar from your server configuration.^7',
      '[server] ^3Warning: `sv_exposePlayerIdentifiersInHttpEndpoint` has been removed. Player names and identifiers are only exposed on `/players.json` when the request is authenticated via `sv_playersToken` (using the `X-Players-Token` header or `?token=` query parameter). Please remove this ConVar from your server configuration.^7',
    ])
  })

  it('keep the clients and the trust of authentication within the ranges of FiveM', async () => {
    const proc = await createProcess()
    for (const line of [
      'set sv_maxclients 3000',
      'set sv_maxClients 2049',
      'sv_authMinTrust 0',
      'sv_authMaxVariance 6',
    ]) {
      runCommand(proc.manager, line, 'system.console')
    }
    expect([proc.take(), proc.manager.console.variables.find('sv_maxclients')?.value]).toEqual([
      [
        '[cmd] Value out of range (3000) - should be at most 2049',
        '[cmd] Value out of range (0) - should be at least 1',
        '[cmd] Value out of range (6) - should be at most 5',
      ],
      '2049',
    ])
  })

  it('read the names of their types as FiveM does', async () => {
    const proc = await createProcess()
    const { variables } = proc.manager.console
    const values = ['OFF', 'no_dummy', 'Relaxed', 'strict', 'false', 'none'].map((text) => {
      runCommand(proc.manager, `sv_entityLockdown ${text}`, 'system.console')
      return variables.find('sv_entityLockdown')?.value
    })
    runCommand(proc.manager, 'gamename RDR3', 'system.console')
    runCommand(proc.manager, 'gamename gta6', 'system.console')
    expect([
      values,
      proc.manager.defaultConsole.variables.find('gamename')?.value,
      proc.take(),
      ['3258', 'mpsum2', 'h4', 'xm18', '007', 'nope'].map((text) => GAME_BUILD.parse(text)),
      // OneSync's state is internal, which no command sets.
      ['ON', 'True', 'LEGACY', 'Off', 'false', 'maybe'].map((text) => ONESYNC_STATE.parse(text)),
      ['GTA4', 'gta5', 'Rdr3'].map((text) => GAME_NAME.parse(text)),
    ]).toEqual([
      ['inactive', 'no_dummy', 'relaxed', 'strict', 'inactive', 'inactive'],
      'rdr3',
      [
        '[cmd] Could not convert argument 0 (none) to fx::EntityLockdownMode',
        '[cmd] Could not convert argument 0 (gta6) to fx::GameName',
      ],
      ['3258', '2699', '2189', '1604', undefined, undefined],
      ['on', 'on', 'legacy', 'off', 'off', undefined],
      ['gta4', 'gta5', 'rdr3'],
    ])
  })

  it('are none of clients', async () => {
    const client = await createProcess({ side: 'client' })
    expect(
      ['sv_maxClients', 'onesync', 'version'].map((name) =>
        client.manager.console.variables.find(name),
      ),
    ).toEqual([undefined, undefined, undefined])
  })
})

/** The variables of a console, as "name value type flags", with the names of their flags. */
function variablesOf(variables: Variables): string[] {
  const names: [number, string][] = [
    [VariableFlags.serverInfo, 'ServerInfo'],
    [VariableFlags.replicated, 'Replicated'],
    [VariableFlags.readOnly, 'ReadOnly'],
    [VariableFlags.userPref, 'UserPref'],
    [VariableFlags.internal, 'Internal'],
    [VariableFlags.archive, 'Archive'],
  ]
  return variables.list().map(({ name, flags, variable }) => {
    const type = typeof variable.type === 'string' ? variable.type : variable.type.name
    const flagNames = names.filter(([flag]) => flags & flag).map(([, flagName]) => flagName)
    return [name, JSON.stringify(variable.value), type, ...flagNames].join(' ')
  })
}

describe('All the variables of servers', () => {
  it('are those that FiveM defines as its server starts', async () => {
    const proc = await createProcess()
    expect([
      variablesOf(proc.manager.console.variables),
      variablesOf(proc.manager.defaultConsole.variables),
    ]).toEqual([
      [
        'buildNumber "37175" int Internal',
        'net_tcpConnLimit "16" int',
        'netlib "enet" string',
        'netPort "0" int',
        'onesync "on" fx::OneSyncState Internal',
        'onesync_automaticResend "false" bool',
        'onesync_distanceCulling "true" bool',
        'onesync_distanceCullVehicles "false" bool',
        'onesync_enableBeyond "true" bool Internal',
        'onesync_enabled "false" bool ServerInfo Internal',
        'onesync_enableInfinity "true" bool Internal',
        'onesync_forceMigration "true" bool',
        'onesync_logFile "" string',
        'onesync_population "true" bool ReadOnly',
        'onesync_radiusFrequency "true" bool',
        'onesync_workaround763185 "false" bool',
        'rcon_password "" string ReadOnly',
        'steam_webApiDomain "api.steampowered.com" string',
        'steam_webApiKey "" string',
        'sv_authMaxVariance "5" int',
        'sv_authMinTrust "1" int',
        'sv_defaultGameBuild "3258" string ServerInfo Internal',
        'sv_enableGetStatus "false" bool',
        'sv_enableNetEventReassembly "true" bool',
        'sv_enableNetworkedPhoneExplosions "false" bool',
        'sv_enableNetworkedScriptEntityStates "true" bool',
        'sv_enableNetworkedSounds "true" bool',
        'sv_endpointPrivacy "false" bool',
        'sv_endpoints "" string',
        'sv_enforceGameBuild "3258" fx::GameBuild ServerInfo ReadOnly',
        'sv_enforceSteamAuth "false" bool ServerInfo',
        'sv_enhancedHostSupport "false" bool ServerInfo',
        'sv_entityLockdown "inactive" fx::EntityLockdownMode',
        'sv_exposePlayerIdentifiersInHttpEndpoint "false" bool',
        'sv_filterRequestControl "0" int',
        'sv_filterRequestControlSettleTimer "30000" int',
        'sv_forceIndirectListing "false" bool',
        'sv_hostname "default FXServer" string ServerInfo',
        'sv_httpFileServerProxyOnly "false" bool',
        'sv_icon "" string Internal',
        'sv_infoVersion "0" int ServerInfo',
        'sv_lan "false" bool ServerInfo',
        'sv_listingHostOverride "" string',
        'sv_listingIpOverride "" string',
        'sv_master1 "https://servers-frontend.fivem.net/api/serverlist/ingress" string',
        'sv_master2 "" string',
        'sv_master3 "" string',
        'sv_maxClientEndpointRequestSize "102400" int',
        'sv_maxClients "30" int ServerInfo',
        'sv_netEventReassemblyMaxPendingEvents "100" uint16',
        'sv_netEventReassemblyUnlimitedPendingEvents "false" bool',
        'sv_netHttp2 "false" bool',
        'sv_playersToken "" string',
        'sv_poolSizesIncrease "" string ServerInfo Internal',
        'sv_profileDataToken "" string',
        'sv_prometheusBasicAuthPassword "" string',
        'sv_prometheusBasicAuthUser "" string',
        'sv_protectServerEntities "false" bool Replicated',
        'sv_pureLevel "0" int ServerInfo',
        'sv_registerMulticastDns "true" bool',
        'sv_replaceExeToSwitchBuilds "false" bool ServerInfo Internal',
        'sv_requestParanoia "0" int',
        'sv_returnClientsListInGetStatus "true" bool',
        'sv_scriptHookAllowed "false" bool ServerInfo',
        'sv_stateBagStrictMode "false" bool',
        'sv_tcpConnectionTimeoutSeconds "5" uint16',
        'sv_tebexSecret "" string',
        'sv_threadedClientHttp "true" bool',
        'sv_useAccurateSends "true" bool',
        'version "FXServer-master SERVER v1.0.0.37175 win32" string Internal',
      ],
      [
        'developer "0" int UserPref Archive',
        'gamename "gta5" fx::GameName ServerInfo',
        'se_debug "false" bool',
        'sv_httpHandlerConnectionTimeoutSeconds "300" uint16',
      ],
    ])
  })
})

describe('The endpoints of servers', () => {
  it('give the port of the first for TCP as the primary one, which netPort holds', async () => {
    const proc = await createProcess()
    const { variables } = proc.manager.console
    const ports = [proc.manager.primaryPort]
    for (const endpoint of ['127.0.0.1:0', '[::]:30125', '0.0.0.0:30126']) {
      runCommand(proc.manager, `endpoint_add_tcp "${endpoint}"`, 'system.console')
      ports.push(proc.manager.primaryPort)
    }
    runCommand(proc.manager, 'endpoint_add_udp "0.0.0.0:30120"', 'system.console')
    expect([ports, variables.find('netPort')?.value, proc.take()]).toEqual([
      [0, 0, 30125, 30125],
      '30125',
      [],
    ])
  })

  it('take the port after the last colon, unless in the brackets of IPv6, or 30120', () => {
    expect(
      ['0.0.0.0', '[::1]', '[::1]:1', 'host:70000', 'host:-1', 'host:abc', ':5'].map(portOf),
    ).toEqual([30120, 30120, 1, 4464, 65535, 0, 5])
  })
})
