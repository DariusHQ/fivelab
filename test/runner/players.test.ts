import { describe, expect, it } from 'vitest'

import { MemoryFileSystem } from '../../src/core/engine/index.ts'
import { runFile, type FileResult } from '../../src/runner/index.ts'
import { cfxlua } from '../lua/helpers.ts'

/** The files of a resource named bank, with its server and client scripts. */
function bank(server: string, client = ''): Record<string, string> {
  return {
    'resources/bank/fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_script 'server.lua'
client_script 'client.lua'`,
    'resources/bank/server.lua': server,
    'resources/bank/client.lua': client,
  }
}

/** Runs `source` as tests/x.test.lua, with the bank that `files` give started. */
async function run(source: string, files: Record<string, string> = bank('')): Promise<FileResult> {
  return runFile(
    { path: 'tests/x.test.lua', source },
    {
      cfxlua: await cfxlua(),
      project: { files: () => new MemoryFileSystem(files), commands: ['ensure bank'] },
    },
  )
}

/** Each test as its names, its status, and the messages of what failed. */
function outcomes(result: FileResult): string[][] {
  return result.tests.map(({ names, status, failures }) => [
    names.join(' > '),
    status,
    ...failures.map(({ message }) => message),
  ])
}

describe('Players of tests', () => {
  it('connect with identities, once their clients started the resources of the server', async () => {
    const result = await run(
      `it('connects', function()
    local ann = fiverunner.connect({
        name = 'Ann',
        guid = '1234',
        identifiers = { 'license:abc', 'discord:1' },
        tokens = { '3:abc' },
        endpoint = '10.0.0.2',
    })
    expect({ ann.id, ann.name }).toEqual({ 1, 'Ann' })
    expect({
        GetPlayerName(ann.id),
        GetPlayerGuid(ann.id),
        GetPlayerIdentifier(ann.id, 1),
        GetPlayerToken(ann.id, 0),
        GetPlayerEndpoint(ann.id),
    }).toEqual({ 'Ann', '1234', 'discord:1', '3:abc', '10.0.0.2' })
    expect(ann:output()).toContain('[script:bank] the client started')
    local bob = fiverunner.connect()
    expect({ bob.id, bob.name, GetNumPlayerIndices() }).toEqual({ 2, 'player', 2 })
end)`,
      bank('', `print('the client started')`),
    )
    expect(outcomes(result)).toEqual([['connects', 'passed']])
  })

  it('come back without players, and with why, when the server refuses them', async () => {
    const result = await run(
      `it('refuses', function()
    local banned, reason = fiverunner.connect({ name = 'Banned' })
    expect({ banned, reason }).toEqual({ nil, 'You are banned' })
end)`,
      bank(`AddEventHandler('playerConnecting', function(name, setKickReason)
    if name == 'Banned' then
        setKickReason('You are banned')
        CancelEvent()
    end
end)`),
    )
    expect(outcomes(result)).toEqual([['refuses', 'passed']])
  })

  it('come back without players when the server drops them before their clients are ready', async () => {
    const result = await run(
      `it('drops', function()
    local player, reason = fiverunner.connect({ name = 'Dropped' })
    expect({ player, reason }).toEqual({ nil, 'the server dropped the player' })
end)`,
      bank(`AddEventHandler('playerJoining', function()
    DropPlayer(source, 'Not now')
end)`),
    )
    expect(outcomes(result)).toEqual([['drops', 'passed']])
  })

  it('run code in their clients, which gives back what it returns or raises', async () => {
    const result = await run(`it('runs', function()
    local ann = fiverunner.connect()
    local sum, none, resource = ann:run('local a, b = ... return a + b, nil, GetCurrentResourceName()', 1, 2)
    expect({ sum, none, resource }).toEqual({ 3, nil, 'fiverunner' })
    expect(ann:run('Wait(100) return IsDuplicityVersion()')).toBe(false)
    expect(function() ann:run('error("boom")') end).toThrow('the client of player 1 raised: (run):1: boom')
    expect(function() ann:run('return +') end).toThrow("the client of player 1 raised: (run):1: unexpected symbol near '+'")
    expect(function() ann:run(1) end).toThrow("bad argument #1 to 'run' (string expected, got number)")
    expect({ select('#', ann:run('return 1, nil')), ann:run('return select("#", ...)', 1, nil) }).toEqual({ 2, 2 })
    expect(function()
        ann:run('error(setmetatable({}, { __tostring = function() error("no") end }))')
    end).toThrow('the client of player 1 raised: (error object is not a string)')
end)
it('leaves', function()
    local ann = fiverunner.connect()
    DropPlayer(ann.id, 'Kicked')
    ann:run('return 1')
end)`)
    expect(outcomes(result)).toEqual([
      ['runs', 'passed'],
      [
        'leaves',
        'failed',
        '@fiverunner/tests/x.test.lua:17: player 1 left before its client ran the code',
      ],
    ])
  })

  it('emit events from their clients to the server, and tell what their clients got from it', async () => {
    const result = await run(
      `it('deposits', function()
    local ann = fiverunner.connect()
    local bob = fiverunner.connect()
    ann:emit('bank:deposit', 100, 'cash')
    expect(ann:received('bank:balance')).toEqual({})
    fiverunner.waitFor(function() return #ann:received('bank:balance') > 0 end)
    expect(ann:received('bank:balance')).toEqual({ { 600, 'cash' } })
    expect(bob:received('bank:balance')).toEqual({})
    ann:run("TriggerEvent('bank:local', 1)")
    expect(ann:received('bank:local')).toEqual({})
    expect(ann:received('fiverunner:run')).toEqual({})
end)`,
      bank(`RegisterNetEvent('bank:deposit', function(amount, kind)
    TriggerClientEvent('bank:balance', source, 500 + amount, kind)
end)`),
    )
    expect(outcomes(result)).toEqual([['deposits', 'passed']])
  })

  it('disconnect, once the server dropped them', async () => {
    const result = await run(
      `it('disconnects', function()
    local ann = fiverunner.connect({ name = 'Ann' })
    ann:disconnect('Bye')
    expect(DoesPlayerExist(ann.id)).toBe(false)
    expect(fiverunner.output()).toContain('[script:bank] dropped\t1\tBye')
    local bob = fiverunner.connect()
    bob:disconnect()
    expect(fiverunner.output()).toContain('[script:bank] dropped\t2\tExiting')
    expect(function() bob:disconnect(1) end).toThrow("bad argument #1 to 'disconnect' (string expected, got number)")
end)`,
      bank(
        `AddEventHandler('playerDropped', function(reason) print('dropped', source, reason) end)`,
      ),
    )
    expect(outcomes(result)).toEqual([['disconnects', 'passed']])
  })

  it('have identities of the kinds that players have', async () => {
    const result = await run(`it('a', function() fiverunner.connect({ nam = 'x' }) end)
it('b', function() fiverunner.connect({ name = 1 }) end)
it('c', function() fiverunner.connect({ identifiers = { 1 } }) end)
it('d', function() fiverunner.connect(1) end)
it('e', function() fiverunner.connect({ tokens = 'x' }) end)`)
    expect(outcomes(result).map(([, , message]) => message)).toEqual([
      '@fiverunner/tests/x.test.lua:1: players have a name, a guid, an endpoint, identifiers and tokens, not "nam"',
      '@fiverunner/tests/x.test.lua:2: the name of a player is a string, not a number',
      '@fiverunner/tests/x.test.lua:3: the identifiers of a player are strings, not number',
      "@fiverunner/tests/x.test.lua:4: bad argument #1 to 'fiverunner.connect' (table expected, got number)",
      '@fiverunner/tests/x.test.lua:5: the tokens of a player is a table, not a string',
    ])
  })
})

describe('fiverunner', () => {
  it('tells what the server and the clients of players printed, without colors', async () => {
    const result = await run(
      `it('prints', function()
    local ann = fiverunner.connect()
    expect(fiverunner.output()).toContain('[script:bank] on the server')
    expect(fiverunner.output()).toContain('[script:bank] SCRIPT ERROR: @bank/server.lua:2: oops')
    expect(ann:output()).toContain('[script:bank] on the client')
    expect(ann:output()).never.toContain('[script:bank] on the server')
    expect(fiverunner.output()).never.toContain('[bank] careful')
end)`,
      bank(
        `print('on the server')
CreateThread(function() error('oops') end)
warn('@on')
warn('careful')`,
        `print('on the client')`,
      ),
    )
    expect(outcomes(result)).toEqual([['prints', 'passed']])
  })

  it('waits for checks to come true', async () => {
    const result = await run(`it('waits', function()
    local runs = 0
    local start = GetGameTimer()
    expect(fiverunner.waitFor(function()
        runs = runs + 1
        return runs >= 3 and runs
    end)).toBe(3)
    expect(GetGameTimer() - start).toBe(100)
end)
it('waits in vain', function() fiverunner.waitFor(function() return false end, 100) end)
it('waits without a check', function() fiverunner.waitFor(1) end)
it('waits for no time', function() fiverunner.waitFor(function() end, '1') end)`)
    // It gave up 100 ms after it started, at the first frame of the server.
    expect(result.tests[1]!.duration).toBe(150)
    expect(outcomes(result)).toEqual([
      ['waits', 'passed'],
      ['waits in vain', 'failed', 'waitFor gave up after 100 ms'],
      [
        'waits without a check',
        'failed',
        "@fiverunner/tests/x.test.lua:11: bad argument #1 to 'fiverunner.waitFor' (function expected, got number)",
      ],
      [
        'waits for no time',
        'failed',
        "@fiverunner/tests/x.test.lua:12: bad argument #2 to 'fiverunner.waitFor' (number expected, got string)",
      ],
    ])
  })
})
