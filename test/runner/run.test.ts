import { describe, expect, it } from 'vitest'

import { MemoryFileSystem } from '../../src/core/engine/index.ts'
import {
  EPOCH,
  runFile,
  type FileResult,
  type OutputLine,
  type RunOptions,
} from '../../src/runner/index.ts'
import { cfxlua } from '../lua/helpers.ts'

/** Runs `source` as tests/x.test.lua, in a project of `files` that `commands` start. */
async function run(
  source: string,
  files: Record<string, string> = {},
  commands: readonly string[] = [],
  options: Partial<RunOptions> = {},
): Promise<FileResult> {
  return runFile(
    { path: 'tests/x.test.lua', source },
    {
      cfxlua: await cfxlua(),
      project: { files: () => new MemoryFileSystem(files), commands },
      ...options,
    },
  )
}

/** Each test as its names, its status, and each failure with the lines it came through. */
function outcomes(result: FileResult): string[][] {
  return result.tests.map(({ names, status, failures }) => [
    names.join(' > '),
    status,
    ...failures.map(
      ({ message, frames }) => `${message} @${frames.map(({ line }) => line).join(',')}`,
    ),
  ])
}

/** What the scripts of the resource that runs the tests printed. */
function printed(output: readonly OutputLine[]): string[] {
  return output.filter(({ channel }) => channel === 'script:fiverunner').map(({ text }) => text)
}

/** A resource whose server script is `server`. */
function resource(name: string, server: string): Record<string, string> {
  return {
    [`resources/${name}/fxmanifest.lua`]: `fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server.lua'`,
    [`resources/${name}/server.lua`]: server,
  }
}

describe('Running test files', () => {
  it('runs their tests in the order they came, each in a server of its own', async () => {
    const result = await run(`local runs = 0
describe('a', function()
    it('passes', function()
        runs = runs + 1
        expect(runs).toBe(1)
    end)
    describe('b', function()
        it('fails', function()
            expect(1 + 1).toBe(3)
        end)
    end)
    it('runs alone', function()
        runs = runs + 1
        expect(runs).toBe(1)
    end)
end)
test('passes at the top', function() end)`)
    expect([result.failure, outcomes(result)]).toEqual([
      undefined,
      [
        ['a > passes', 'passed'],
        ['a > b > fails', 'failed', 'expected 2 to be 3 @9'],
        ['a > runs alone', 'passed'],
        ['passes at the top', 'passed'],
      ],
    ])
  })

  it('runs the hooks of the describes that tests are in around them', async () => {
    const result = await run(`local log = {}
beforeEach(function() log[#log + 1] = 'outer before' end)
afterEach(function()
    log[#log + 1] = 'outer after'
    print(table.concat(log, ', '))
end)
describe('d', function()
    beforeEach(function() log[#log + 1] = 'before 1' end)
    beforeEach(function() log[#log + 1] = 'before 2' end)
    afterEach(function() log[#log + 1] = 'after 1' end)
    afterEach(function() log[#log + 1] = 'after 2' end)
    it('t', function() log[#log + 1] = 'test' end)
end)
it('alone', function() log[#log + 1] = 'alone' end)`)
    expect(result.tests.map(({ output }) => printed(output))).toEqual([
      ['outer before, before 1, before 2, test, after 2, after 1, outer after'],
      ['outer before, alone, outer after'],
    ])
  })

  it('fails tests whose hooks fail, which skips them and the later beforeEach hooks', async () => {
    const result = await run(`describe('d', function()
    beforeEach(function() error('before') end)
    beforeEach(function() print('second before') end)
    afterEach(function() print('after') end)
    afterEach(function() error('after too') end)
    it('t', function() print('test') end)
end)`)
    expect([outcomes(result), printed(result.tests[0]!.output)]).toEqual([
      [
        [
          'd > t',
          'failed',
          '@fiverunner/tests/x.test.lua:2: before @2',
          '@fiverunner/tests/x.test.lua:5: after too @5',
        ],
      ],
      ['after'],
    ])
  })

  it('skips tests, and runs those that the file marks with only alone', async () => {
    const marked = await run(`it('a', function() end)
it.skip('b', function() end)
describe.only('c', function()
    it('d', function() end)
    it.skip('e', function() end)
end)
test.only('f', function() end)
describe.skip('g', function()
    it.only('h', function() end)
end)`)
    const unmarked = await run(`it('a', function() end)
test.skip('b', function() end)`)
    expect([outcomes(marked), outcomes(unmarked)]).toEqual([
      [
        ['a', 'skipped'],
        ['b', 'skipped'],
        ['c > d', 'passed'],
        ['c > e', 'skipped'],
        ['f', 'passed'],
        ['g > h', 'skipped'],
      ],
      [
        ['a', 'passed'],
        ['b', 'skipped'],
      ],
    ])
  })

  it('fails tests that do not end within their timeouts, by the clocks of their servers', async () => {
    const result = await run(`it('waits', function() Wait(4000) end)
it('waits too long', function() Wait(6000) end)
it('has a timeout of its own', function() Wait(6000) end, 7000)
it('waits longer than its own', function() Wait(1000) end, 520)`)
    expect([outcomes(result), result.tests.map(({ duration }) => duration)]).toEqual([
      [
        ['waits', 'passed'],
        ['waits too long', 'failed', 'the test did not end within 5000 ms @'],
        ['has a timeout of its own', 'passed'],
        ['waits longer than its own', 'failed', 'the test did not end within 520 ms @'],
      ],
      [4050, 5000, 6050, 520],
    ])
  })

  it('reports the lines of the test file that failures came through', async () => {
    const result = await run(`local function check(value)
    expect(value).toBe(true)
end
it('checks', function()
    check(false)
end)
it('raises', function()
    local t = nil
    return t.x
end)`)
    expect(result.tests.map(({ failures }) => failures)).toEqual([
      [{ message: 'expected false to be true', frames: [{ line: 2, name: 'check' }, { line: 5 }] }],
      [
        {
          message: "@fiverunner/tests/x.test.lua:9: attempt to index a nil value (local 't')",
          frames: [{ line: 9 }],
        },
      ],
    ])
  })

  it('fails files that do not load, with what they raised', async () => {
    const results = await Promise.all([
      run(`it('a', function() end)\nlocal = 1`),
      run(`local function broken()\n    error('broken')\nend\nbroken()`),
      run(`describe(1, function() end)`),
      run(`it('a', function() end, 0)`),
      run(`Wait(6000)`),
      run(`it.only(1, function() end)`),
      run(`describe.skip('x', 1)`),
      run(`describe.only('x')`),
      run(`test.skip('x', function() end, math.huge)`),
      run(`it('x', function() end, '5')`),
      run(`beforeEach(1)`),
      run(`afterEach()`),
    ])
    expect(results.map(({ tests, failure }) => [tests, failure])).toEqual([
      [[], { message: "@fiverunner/tests/x.test.lua:2: <name> expected near '='", frames: [] }],
      [
        [],
        {
          message: '@fiverunner/tests/x.test.lua:2: broken',
          frames: [{ line: 2, name: 'broken' }, { line: 4 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #1 to 'describe' (string expected, got number)",
          frames: [{ line: 1 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #3 to 'it' (milliseconds expected, got 0)",
          frames: [{ line: 1 }],
        },
      ],
      [[], { message: 'the test file did not load within 5000 ms', frames: [] }],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #1 to 'it.only' (string expected, got number)",
          frames: [{ line: 1 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #2 to 'describe.skip' (function expected, got number)",
          frames: [{ line: 1 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #2 to 'describe.only' (function expected, got nil)",
          frames: [{ line: 1 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #3 to 'test.skip' (milliseconds expected, got inf)",
          frames: [{ line: 1 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #3 to 'it' (milliseconds expected, got string)",
          frames: [{ line: 1 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #1 to 'beforeEach' (function expected, got number)",
          frames: [{ line: 1 }],
        },
      ],
      [
        [],
        {
          message:
            "@fiverunner/tests/x.test.lua:1: bad argument #1 to 'afterEach' (function expected, got nil)",
          frames: [{ line: 1 }],
        },
      ],
    ])
  })

  it('takes tests, describes and hooks only as the file loads', async () => {
    const result = await run(`it('adds', function()
    it('inner', function() end)
end)
it('hooks', function()
    beforeEach(function() end)
end)`)
    expect(outcomes(result)).toEqual([
      [
        'adds',
        'failed',
        '@fiverunner/tests/x.test.lua:2: it adds to the tests of the file only as it loads @2',
      ],
      [
        'hooks',
        'failed',
        '@fiverunner/tests/x.test.lua:5: beforeEach adds to the tests of the file only as it loads @5',
      ],
    ])
  })

  it('fails tests of files whose tests change from one load to the next', async () => {
    const changed = await run(`local target = FiverunnerCall('target', msgpack.pack({}))
it(target.test == nil and 'first' or 'other', function() end)`)
    const fewer = await run(`local target = FiverunnerCall('target', msgpack.pack({}))
it('a', function() end)
if target.test == nil then it('b', function() end) end`)
    const broken = await run(`local target = FiverunnerCall('target', msgpack.pack({}))
it('a', function() end)
if target.test ~= nil then error('only as it runs') end`)
    const unnested = await run(`if FiverunnerCall('target').test == nil then
    describe('a', function() it('b', function() end) end)
else
    it('a', function() end)
end`)
    expect([outcomes(changed), outcomes(fewer), outcomes(broken), outcomes(unnested)]).toEqual([
      [['first', 'failed', 'the test file has other tests than it had as it first loaded @']],
      [
        ['a', 'passed'],
        ['b', 'failed', 'the test file has fewer tests than it had @'],
      ],
      [['a', 'failed', '@fiverunner/tests/x.test.lua:3: only as it runs @3']],
      [['a > b', 'failed', 'the test file has other tests than it had as it first loaded @']],
    ])
  })

  it('runs each test once the threads that the project started ran', async () => {
    const files = resource(
      'ready',
      `local ready = false
CreateThread(function() ready = true end)
exports('ready', function() return ready end)`,
    )
    const result = await run(
      `it('finds the project ready', function() expect(exports.ready:ready()).toBe(true) end)`,
      files,
      ['ensure ready'],
    )
    expect(outcomes(result)).toEqual([['finds the project ready', 'passed']])
  })

  it('reports what tests raise that tostring cannot show, and the first lines that deep failures came through', async () => {
    const result = await run(`local function deep() return 1 + deep() end
it('recurses', function() deep() end)
it('raises', function() error(setmetatable({}, { __tostring = function() error('no') end })) end)
it('raises nil', function() error() end)`)
    const [recurses, raises, raisesNil] = result.tests.map(({ failures }) => failures[0]!)
    expect([
      recurses!.message,
      recurses!.frames.length,
      recurses!.frames[0],
      raises,
      raisesNil,
    ]).toEqual([
      '@fiverunner/tests/x.test.lua:1: stack overflow',
      20,
      { line: 1, name: 'deep' },
      { message: '(error object is not a string)', frames: [{ line: 3 }] },
      { message: 'nil', frames: [{ line: 4 }] },
    ])
  })

  it('runs tests with the resources of the project that its commands start', async () => {
    const files = {
      ...resource('bank', `exports('balance', function() return 500 end)`),
      ...resource('idle', ''),
    }
    const result = await run(
      `it('calls the project', function()
    expect(GetResourceState('bank')).toBe('started')
    expect(GetResourceState('idle')).toBe('stopped')
    expect(exports.bank:balance()).toBe(500)
end)`,
      files,
      ['ensure bank'],
    )
    expect(outcomes(result)).toEqual([['calls the project', 'passed']])
  })

  it('gives each test the files of the project as they were', async () => {
    const files = {
      ...resource(
        'bank',
        `exports('save', function() SaveResourceFile('bank', 'data.txt', 'new', -1) end)`,
      ),
      'resources/bank/data.txt': 'old',
    }
    const result = await run(
      `for _ = 1, 2 do
    it('writes', function()
        expect(LoadResourceFile('bank', 'data.txt')).toBe('old')
        exports.bank:save()
        expect(LoadResourceFile('bank', 'data.txt')).toBe('new')
    end)
end`,
      files,
      ['ensure bank'],
    )
    expect(outcomes(result)).toEqual([
      ['writes', 'passed'],
      ['writes', 'passed'],
    ])
  })

  it('starts the wall clocks of the servers of tests at the same time, in UTC', async () => {
    const seconds = EPOCH / 1000
    const result = await run(`it('reads the time', function()
    expect(os.time()).toBe(${seconds})
    expect(os.date('%Y-%m-%d %H:%M:%S %z')).toBe('2026-01-01 00:00:00 +0000')
    Wait(2000)
    expect(os.time()).toBe(${seconds + 2})
end)`)
    expect([EPOCH, outcomes(result)]).toEqual([1767225600000, [['reads the time', 'passed']]])
  })

  it('sends no HTTP requests', async () => {
    const result = await run(`it('requests', function()
    local done = promise.new()
    PerformHttpRequest('https://example.com/', function(status, body, headers, err)
        print(status, body, err)
        done:resolve()
    end)
    Citizen.Await(done)
end)`)
    expect(printed(result.tests[0]!.output)).toEqual([
      "0\tnil\tFiveRunner sends no HTTP requests in tests - CURL error code 7 (Couldn't connect to server)",
    ])
  })

  it('fails tests whose servers crash', async () => {
    const result = await run(
      `it('loops', function()
    while true do pcall(function() while true do end end) end
end)`,
      {},
      [],
      { watchdog: { timeoutMs: 20, killAfterMs: 40, interval: 100 } },
    )
    expect([outcomes(result), result.tests[0]!.duration]).toEqual([
      [
        [
          'loops',
          'failed',
          expect.stringMatching(
            /^the server crashed: Lua state stopped: a script kept running for \d+ ms after the watchdog raised an error @$/,
          ),
        ],
      ],
      50,
    ])
  })

  it('fails files whose servers crash as they load', async () => {
    const result = await run(`while true do pcall(function() while true do end end) end`, {}, [], {
      watchdog: { timeoutMs: 20, killAfterMs: 40, interval: 100 },
    })
    expect([result.tests, result.failure?.message]).toEqual([
      [],
      expect.stringMatching(/^the server crashed: Lua state stopped: /),
    ])
  })

  it('lets tests run the commands that the console may', async () => {
    const files = resource('bank', `print('bank started')`)
    const result = await run(
      `it('restarts', function()
    ExecuteCommand('ensure bank')
    Wait(0)
end)`,
      files,
      ['ensure bank'],
    )
    const started = result.tests[0]!.output.filter(({ text }) => text === 'bank started')
    expect([outcomes(result), started.length]).toEqual([[['restarts', 'passed']], 2])
  })

  it('lets only the tests ask the runner for what they run', async () => {
    const files = resource(
      'sneaky',
      `exports('ask', function() return pcall(FiverunnerCall, 'target', msgpack.pack({})) end)`,
    )
    const result = await run(
      `it('asks', function()
    local ok, err = exports.sneaky:ask()
    expect(ok).toBe(false)
    expect(err).toContain('Only the tests may call this')
end)`,
      files,
      ['ensure sneaky'],
    )
    expect(outcomes(result)).toEqual([['asks', 'passed']])
  })

  it('refuses what the harness would neither ask nor report', async () => {
    // A report that the runner took would end the test, so each prints what it got.
    const result = await run(`local function refuse(...)
    print(select(2, pcall(FiverunnerCall, ...)))
end
if FiverunnerCall('target').test == nil then
    refuse('report', msgpack.pack({ tests = { { names = {}, mode = 'x' } } }))
    refuse('report', msgpack.pack({ tests = { { names = {}, mode = 'run', timeout = 'x' } } }))
    refuse('report', msgpack.pack({ tests = { { 'x' } } }))
    refuse('report', msgpack.pack({ tests = {}, failure = 1 }))
    refuse('report', msgpack.pack({}))
end
it('forges', function()
    print(FiverunnerCall('target').file)
    refuse('nope', msgpack.pack({}))
    refuse('report')
    refuse('report', msgpack.pack({ failures = 1 }))
    refuse('report', msgpack.pack({ failures = { a = 1 } }))
    refuse('report', msgpack.pack({ failures = { { message = 1, frames = {} } } }))
    refuse('report', msgpack.pack({ failures = { { message = 'm', frames = { { name = 'f' } } } } }))
    refuse('report', msgpack.pack({ names = { 1 }, failures = {} }))
    refuse('connect', msgpack.pack({ name = 1 }))
    refuse('connect', msgpack.pack({ identifiers = 'x' }))
    refuse('connection', msgpack.pack(99))
    refuse('connection', msgpack.pack('x'))
    refuse('connection', msgpack.pack(1.5))
    refuse('output', msgpack.pack({ id = 99 }))
    refuse('received', msgpack.pack({ id = 99, event = 'x' }))
    refuse('disconnect', msgpack.pack({ id = 99 }))
end)`)
    const refused = (output: readonly OutputLine[]) =>
      printed(output).map((line) => line.replace(/^.*: /, ''))
    expect([outcomes(result), refused(result.output), refused(result.tests[0]!.output)]).toEqual([
      [['forges', 'passed']],
      [
        'Unknown mode x',
        'Timeouts are numbers',
        'Expected a table',
        'Expected a table',
        'Expected a table',
      ],
      [
        'tests/x.test.lua',
        'Unknown method nope',
        'Expected a table',
        'Expected a list',
        'Expected a list',
        'Expected a string',
        'Frames have lines',
        'Expected a string',
        'Expected a string',
        'Expected a list',
        'Unknown connection',
        'Expected a whole number',
        'Expected a whole number',
        'No player has the id 99',
        'No player has the id 99',
        'No player has the id 99',
      ],
    ])
  })

  it('ends the lines that processes leave without line breaks', async () => {
    const result = await run(`it('traces', function()
    Citizen.Trace('a')
    Citizen.Trace('b\\nc')
end)`)
    expect(printed(result.tests[0]!.output)).toEqual(['ab', 'c'])
  })

  it('gives what the processes printed with each test', async () => {
    const result = await run(`print('loading')
it('prints', function() print('in the test') end)`)
    expect([printed(result.output), printed(result.tests[0]!.output)]).toEqual([
      ['loading'],
      ['loading', 'in the test'],
    ])
    expect(result.tests[0]!.output).toContainEqual({
      process: 'server',
      kind: 'console',
      channel: 'resources',
      text: 'Started resource fiverunner',
    })
  })

  it('refuses projects with a resource that has the name of the one that runs the tests', async () => {
    await expect(run(`it('t', function() end)`, resource('fiverunner', ''))).rejects.toThrow(
      new Error(
        'The project has a resource named fiverunner, the name of the resource that runs its tests',
      ),
    )
  })

  it('refuses test files whose paths do not end in .test.lua', async () => {
    const options = {
      cfxlua: await cfxlua(),
      project: { files: () => new MemoryFileSystem(), commands: [] },
    }
    await expect(runFile({ path: 'tests/x.lua', source: '' }, options)).rejects.toThrow(
      new Error('The paths of test files end in .test.lua, as tests/x.lua does not'),
    )
  })

  it('tells about each test as it ends, or as it is skipped', async () => {
    const seen: string[] = []
    await run(`it('a', function() end)\nit.skip('b', function() end)`, {}, [], {
      onResult: ({ names, status }) => seen.push(`${names.join(' > ')} ${status}`),
    })
    expect(seen).toEqual(['a passed', 'b skipped'])
  })
})
