import { describe, expect, it } from 'vitest'

import { Session, type PlayerIdentity } from '../../src/core/engine/index.ts'
import { createProcess, join, runCommand, type TestProcess } from './helpers.ts'

/** A manifest for clients that runs main.lua, with natives FiveLab has. */
const CLIENT_SCRIPT = [
  ['fx_version', 'cerulean'],
  ['client_script', 'main.lua'],
] as const

interface TestSession {
  readonly server: TestProcess
  readonly clients: TestProcess[]
  readonly session: Session
  /** Runs Lua code on the server in a resource of its own, and returns what it printed. */
  run(code: string): string[]
  /** Runs Lua code on the server in a resource of its own, and returns what all scripts printed. */
  runAll(code: string): string[]
}

/** A server whose clients connected as `identities`. */
async function sessionOf(
  options: { oneSync?: boolean },
  ...identities: PlayerIdentity[]
): Promise<TestSession> {
  const server = await createProcess(options)
  const session = new Session(server.manager)
  const clients: TestProcess[] = []
  for (const identity of identities) {
    const client = await createProcess({ side: 'client' })
    session.connect(client.manager, identity)
    clients.push(client)
  }
  // The server lets them connect at its next tick, and gives them their net ids at the one after.
  server.manager.tick()
  server.manager.tick()
  let count = 0
  const runAll = (code: string) => {
    server.add(`run${count++}`, { 'main.lua': code }).start()
    return server.take().filter((line) => line.startsWith('[script:'))
  }
  const run = (code: string) => {
    const prefix = `[script:run${count}] `
    return runAll(code)
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
  }
  return { server, clients, session, run, runAll }
}

const ANN: PlayerIdentity = {
  name: 'Ann',
  guid: '110000100000001',
  identifiers: ['license2:bb', 'license:aa', 'ip:10.0.0.1'],
  tokens: ['3:xx', '4:yy'],
  endpoint: '10.0.0.1',
}

describe('Players', () => {
  it('have the names, GUIDs, identifiers, tokens and endpoints of their clients', async () => {
    const { run } = await sessionOf({}, ANN, {})
    expect(
      run(`print(GetPlayerName('1'), GetPlayerGuid(1), GetPlayerEndpoint('1st'))
print(GetNumPlayerIdentifiers(1), table.concat(GetPlayerIdentifiers(1), ','))
print(GetPlayerIdentifier(1, -1), GetPlayerIdentifier(1, 3))
print(GetPlayerIdentifierByType(1, 'license'), GetPlayerIdentifierByType(1, 'license:'))
print(GetPlayerIdentifierByType(1, 'ip'), GetPlayerIdentifierByType(1, 'discord'), GetPlayerIdentifierByType(1, 'bb'))
print(GetNumPlayerTokens(1), table.concat(GetPlayerTokens(1), ','), GetPlayerToken(1, 2))
print(GetPlayerName(2), GetPlayerGuid(2), GetPlayerEndpoint(2), GetNumPlayerIdentifiers(2))
print(GetPlayerName(9), GetPlayerGuid(9), GetPlayerEndpoint(9), GetNumPlayerIdentifiers(9))
print(GetPlayerIdentifier(9, 0), GetPlayerIdentifierByType(9, nil), GetNumPlayerTokens(9))
print(pcall(GetPlayerIdentifierByType, 1, nil))
print(pcall(GetPlayerName, nil))`),
    ).toEqual([
      'Ann\t110000100000001\t10.0.0.1',
      '3\tlicense2:bb,license:aa,ip:10.0.0.1',
      'nil\tnil',
      // FiveM takes the first identifier that starts with the type.
      'license2:bb\tlicense:aa',
      'ip:10.0.0.1\tnil\tnil',
      '2\t3:xx,4:yy\tnil',
      // By default, players have the temporary net ids they connected with for GUIDs.
      'player\t65537\t127.0.0.1\t0',
      'nil\tnil\tnil\t0',
      'nil\tnil\t0',
      'false\tnative 00000000a61c8fc6: Argument at index 1 was null.',
      'false\tnative 00000000406b4b20: Argument at index 0 was null.',
    ])
  })

  it('belong to servers, as natives of clients have the same names for players of the game', async () => {
    const { clients } = await sessionOf({}, ANN)
    const client = clients[0]!
    client.add('c', { 'main.lua': `print(GetPlayerName(1))` }, CLIENT_SCRIPT).start()
    expect(client.take().filter((line) => line.startsWith('[script:'))).toEqual(['[script:c] nil'])
    expect(client.diagnostics).toEqual([
      'c: GetPlayerName is not implemented in FiveLab yet: it does nothing and returns zero values.',
    ])
  })

  it('exist by their net ids, as atoi reads them', async () => {
    const { run } = await sessionOf({}, {})
    expect(run(`print(DoesPlayerExist('1'), DoesPlayerExist('1st'), DoesPlayerExist(2))`)).toEqual([
      '1\t1\tfalse',
    ])
  })

  it('are listed as GetNumPlayerIndices last listed them, but for those that dropped since', async () => {
    const { run, session } = await sessionOf({}, {}, {}, {})
    expect(run(`print(table.concat(GetPlayers(), ','))`)).toEqual(['1,2,3'])
    session.player(2)!.quit()
    expect(
      run(`print(GetPlayerFromIndex(0), GetPlayerFromIndex(1), GetPlayerFromIndex(2), GetPlayerFromIndex(3), GetPlayerFromIndex(-1))
print(table.concat(GetPlayers(), ','))`),
    ).toEqual(['1\tnil\t3\tnil\tnil', '1,3'])
  })

  it('tell how long they are online, and since the server last heard from them', async () => {
    const { server, clients, session, run } = await sessionOf({})
    server.time = 1000
    const client = await createProcess({ side: 'client' })
    const player = join(session, client.manager)
    clients.push(client)
    server.time = 1500
    // The server heard from the client as it connected.
    expect(run(`print(GetPlayerLastMsg(1), GetPlayerTimeOnline(1))`)).toEqual(['500\t0'])
    server.time = 3500
    client.manager.tick()
    server.time = 4000
    player.ping = 30
    expect(
      run(`print(GetPlayerLastMsg(1), GetPlayerTimeOnline(1), GetPlayerPing(1))
print(GetPlayerLastMsg(9), GetPlayerTimeOnline(9), GetPlayerPing(9))`),
    ).toEqual(['500\t2\t30', '2147483647\t0\t0'])
  })

  it('may access what their principals may: their identifiers, then their net id', async () => {
    const { server, run } = await sessionOf({}, ANN, {})
    for (const line of [
      'add_ace identifier.license:aa command.a allow',
      'add_ace player.2 command.b allow',
      'add_principal player.2 group.admin',
      'add_ace group.admin command.c allow',
    ]) {
      runCommand(server.manager, line, 'system.console')
    }
    expect(
      run(`print(IsPlayerAceAllowed(1, 'command.a'), IsPlayerAceAllowed(1, 'command.b'))
print(IsPlayerAceAllowed(2, 'command.b'), IsPlayerAceAllowed(2, 'command.c'), IsPlayerAceAllowed(2, 'command.a'))
print(IsPlayerAceAllowed(9, 'command.a'), IsPlayerAceAllowed(9, nil))
print(pcall(IsPlayerAceAllowed, 1, nil))`),
    ).toEqual([
      '1\tfalse',
      '1\t1\tfalse',
      'false\tfalse',
      'false\tnative 00000000dedae23d: Argument at index 1 was null.',
    ])
    expect(server.manager.session!.player(1)!.principals).toEqual([
      'identifier.license2:bb',
      'identifier.license:aa',
      'identifier.ip:10.0.0.1',
      'player.1',
    ])
  })
})

describe('Dropping players', () => {
  it('triggers playerDropped once, with the reason, the resource and why', async () => {
    const { server, clients, session, runAll } = await sessionOf({}, ANN, {}, {})
    server
      .add('watch', {
        'main.lua': `AddEventHandler('playerDropped', function(...)
    print('dropped', source, ...)
    print('players', table.concat(GetPlayers(), ','))
    DropPlayer(source, 'again')
end)`,
      })
      .start()
    server.take()
    // Declared void, DropPlayer sets whether it dropped, which FiveM's result checks poison.
    expect(
      runAll(`print(pcall(DropPlayer, 1, nil))
print(DropPlayer(9, nil), DropPlayer(1, 'bye'), DropPlayer(9, 'nobody'))`),
    ).toEqual([
      // FiveM checks the reason only once it found the player.
      '[script:run0] false\tnative 00000000ba0613e1: Argument at index 1 was null.',
      '[script:watch] dropped\t1\tbye\trun0\t1',
      '[script:watch] players\t1,2,3',
      '[script:run0] false\t2146290430\tfalse',
    ])
    expect([clients[0]!.manager.session, clients[0]!.manager.player]).toEqual([
      undefined,
      undefined,
    ])
    expect(session.player(1)).toBe(undefined)
    const dropped = runAll(`DropPlayer(2, '')`)
    const third = session.player(3)!
    third.quit()
    third.quit('again')
    expect([...dropped, ...server.take()]).toEqual([
      '[script:watch] dropped\t2\tDropped.\trun1\t1',
      '[script:watch] players\t2,3',
      '[script:watch] dropped\t3\tExiting\t__cfx_internal:client\t2',
      '[script:watch] players\t3',
    ])
    expect(Array.from(session.players)).toEqual([])
  })

  it('drops only the players of its session', async () => {
    const first = await sessionOf({}, {})
    const second = await sessionOf({}, {})
    const player = first.session.player(1)!
    second.session.drop(player, 'not mine')
    expect([first.session.player(1), second.session.player(1)?.dropping]).toEqual([player, false])
    expect(player.dropping).toBe(false)
  })

  it('gives no net id again before it gave all the others', async () => {
    const { session } = await sessionOf({}, {}, {})
    session.player(2)!.quit()
    const client = await createProcess({ side: 'client' })
    expect(join(session, client.manager).netId).toBe(3)
  })

  it('tells the other clients without OneSync, with onPlayerDropped', async () => {
    for (const oneSync of [true, false]) {
      const { server, clients, session } = await sessionOf({ oneSync }, ANN, {})
      clients[1]!
        .add(
          'c',
          {
            'main.lua': `RegisterNetEvent('onPlayerDropped', function(...) print('left', ...) end)`,
          },
          CLIENT_SCRIPT,
        )
        .start()
      // The client downloads what its server has, which is nothing.
      clients[1]!.manager.tick()
      clients[1]!.take()
      session.player(1)!.quit()
      session.tick()
      expect(clients[1]!.take()).toEqual(oneSync ? [] : ['[script:c] left\t1\tAnn\t-1'])
      expect(server.diagnostics).toEqual([])
    }
  })
})
