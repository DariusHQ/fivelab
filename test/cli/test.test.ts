import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { main, type CliHost } from '../../src/cli/main.ts'
import { cfxlua } from '../lua/helpers.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fiverunner-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Writes `files` in the directory at `path` in the root, by their paths there, and returns its path. */
function write(path: string, files: Record<string, string>): string {
  const directory = join(root, path)
  mkdirSync(directory, { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    writeFileSync(join(directory, file), text)
  }
  return directory
}

/** Runs fiverunner test with `args` in `cwd`, and returns its exit code with what it wrote. */
async function test(
  cwd: string,
  args: readonly string[] = [],
  host: Partial<CliHost> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  let time = 1000
  const code = await main(['test', ...args], {
    cwd,
    env: {},
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    color: false,
    cfxlua,
    // The run takes a second and a quarter.
    now: () => (time += 625),
    ...host,
  })
  return { code, stdout, stderr }
}

const MANIFEST = `fx_version 'cerulean'
game 'gta5'
server_script 'server.lua'`

/** A resource named bank, with a balance that its export gives, and `tests`. */
function bank(tests: Record<string, string>): string {
  return write('bank', {
    'fxmanifest.lua': MANIFEST,
    'server.lua': `exports('balance', function() return 500 end)`,
    ...tests,
  })
}

describe('fiverunner test', () => {
  it('runs the tests of a resource, and reports what failed', async () => {
    const directory = bank({
      'tests/bank.test.lua': `describe('bank', function()
    it('gives balances', function() expect(exports.bank:balance()).toBe(500) end)
    it('runs alone', function() end)
    it.skip('waits', function() end)
end)`,
      'tests/broken.test.lua': `it('a', function() end)\nlocal = 1`,
      'tests/fails.test.lua': `describe('bank', function()
    it('fails', function()
        print('checking')
        expect(exports.bank:balance()).toBe(600)
    end)
end)`,
    })
    expect(await test(directory)).toEqual({
      code: 1,
      stdout: `✓ tests/bank.test.lua (3 tests, 1 skipped)
× tests/broken.test.lua (did not load)
× tests/fails.test.lua (1 test, 1 failed)
   × bank > fails

Failed: tests/broken.test.lua
  tests/broken.test.lua:2: <name> expected near '='

Failed: tests/fails.test.lua > bank > fails
  expected 500 to be 600
    at tests/fails.test.lua:4
  Output:
    [script:fiverunner] checking

Test files: 2 failed, 1 passed (3)
Tests: 1 failed, 2 passed, 1 skipped (4)
Duration: 0.63 s
`,
      stderr: '',
    })
  })

  it('shows what the processes printed with what failed, but that resources started', async () => {
    const directory = bank({
      'client.lua': `print('client of bank')`,
      'tests/bank.test.lua': `local function check(value)
    expect(value).toBe(true)
end
it('fails deep', function()
    warn('careful')
    GetEntityCoords(0)
    ExecuteCommand('restart bank')
    CreateThread(function() error('oops') end)
    local ann = fiverunner.connect()
    check(false)
end)`,
    })
    writeFileSync(join(directory, 'fxmanifest.lua'), `${MANIFEST}\nclient_script 'client.lua'`)
    const { stdout } = await test(directory)
    expect(stdout.split('\n\n')[1]).toBe(`Failed: tests/bank.test.lua > fails deep
  expected false to be true
    at tests/bank.test.lua:2 (check)
    at tests/bank.test.lua:10
  Output:
    [fiverunner] Lua warning: careful
    [fiverunner] FiveRunner: GetEntityCoords is not implemented in FiveRunner yet: it does nothing and returns zero values.
    [script:fiverunner] SCRIPT ERROR: @fiverunner/tests/bank.test.lua:8: oops
    client 1 [script:bank] client of bank`)
  })

  it('annotates what failed on GitHub Actions, at the paths of the workspace', async () => {
    const directory = bank({
      'tests/fails.test.lua': `it('fails: once, twice', function()\n    expect(1).toBe(2)\nend)`,
      'tests/times out.test.lua': `it('waits', function() Wait(6000) end)`,
      'tests/broken.test.lua': `error('100%\\r\\nbroken')`,
      'tests/syntax.test.lua': `\n\nlocal = 1`,
    })
    const github = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: root }
    const inside = (await test(directory, [], { env: github })).stdout
    const outside = (await test(directory, [], { env: { GITHUB_ACTIONS: 'true' } })).stdout
    const annotations = (stdout: string) =>
      stdout.split('\n').filter((line) => line.startsWith('::'))
    expect([annotations(inside), annotations(outside)[0], inside.split('\n\n')[1]]).toEqual([
      [
        '::error file=bank/tests/broken.test.lua,line=1,title=tests/broken.test.lua::tests/broken.test.lua:1: 100%25%0D%0Abroken',
        '::error file=bank/tests/fails.test.lua,line=2,title=tests/fails.test.lua > fails%3A once%2C twice::expected 1 to be 2',
        "::error file=bank/tests/syntax.test.lua,line=3,title=tests/syntax.test.lua::tests/syntax.test.lua:3: <name> expected near '='",
        '::error file=bank/tests/times out.test.lua,title=tests/times out.test.lua > waits::the test did not end within 5000 ms',
      ],
      '::error file=tests/broken.test.lua,line=1,title=tests/broken.test.lua::tests/broken.test.lua:1: 100%25%0D%0Abroken',
      'Failed: tests/broken.test.lua\n  tests/broken.test.lua:1: 100%\r\n  broken\n    at tests/broken.test.lua:1',
    ])
  })

  it('runs the test files in the paths given, relative to the project', async () => {
    const directory = bank({
      'tests/a.test.lua': `it('a', function() end)`,
      'tests/more/b.test.lua': `it('b', function() end)`,
      'other/c.test.lua': `it('c', function() end)`,
      'notes.txt': '',
    })
    const ran = async (...args: string[]) => {
      const { code, stdout, stderr } = await test(directory, args)
      return [code, stdout.split('\n').filter((line) => line.startsWith('✓')), stderr]
    }
    expect(
      await Promise.all([
        ran('tests'),
        ran('./tests/more/', 'other/c.test.lua'),
        ran('tests/a.test.lua', 'tests'),
        ran('.'),
        ran('missing'),
        ran('tests/missing.test.lua'),
        ran('missing/x.test.lua'),
        ran('notes.txt/x.test.lua'),
        ran('notes.txt'),
        ran('..'),
        ran(join(root, 'elsewhere')),
      ]),
    ).toEqual([
      [0, ['✓ tests/a.test.lua (1 test)', '✓ tests/more/b.test.lua (1 test)'], ''],
      [0, ['✓ other/c.test.lua (1 test)', '✓ tests/more/b.test.lua (1 test)'], ''],
      [0, ['✓ tests/a.test.lua (1 test)', '✓ tests/more/b.test.lua (1 test)'], ''],
      [
        0,
        [
          '✓ other/c.test.lua (1 test)',
          '✓ tests/a.test.lua (1 test)',
          '✓ tests/more/b.test.lua (1 test)',
        ],
        '',
      ],
      [2, [], 'fiverunner: there is no missing\n'],
      [2, [], 'fiverunner: there is no tests/missing.test.lua\n'],
      [2, [], 'fiverunner: there is no missing/x.test.lua\n'],
      [2, [], 'fiverunner: there is no notes.txt/x.test.lua\n'],
      [
        2,
        [],
        'fiverunner: notes.txt is no test file, as the names of test files end in .test.lua\n',
      ],
      [2, [], 'fiverunner: .. is not in the project\n'],
      [2, [], `fiverunner: ${join(root, 'elsewhere')} is not in the project\n`],
    ])
  })

  it('runs the tests of servers, with their server.cfg', async () => {
    const directory = write('server', {
      'server.cfg': 'ensure bank',
      'resources/[local]/bank/fxmanifest.lua': MANIFEST,
      'resources/[local]/bank/server.lua': `exports('balance', function() return 500 end)`,
      'tests/bank.test.lua': `it('gives balances', function() expect(exports.bank:balance()).toBe(500) end)`,
    })
    expect(await test(directory)).toEqual({
      code: 0,
      stdout: `✓ tests/bank.test.lua (1 test)

Test files: 1 passed (1)
Tests: 1 passed (1)
Duration: 0.63 s
`,
      stderr: '',
    })
  })

  it('fails without test files, or without tests in them', async () => {
    const none = await test(bank({}))
    rmSync(join(root, 'bank'), { recursive: true })
    const empty = await test(
      bank({
        'tests/empty.test.lua': '',
        'tests/skipped.test.lua': `it.skip('a', function() end)`,
      }),
    )
    expect([none, empty]).toEqual([
      {
        code: 1,
        stdout: '',
        stderr: 'fiverunner: there are no test files, whose names end in .test.lua\n',
      },
      {
        code: 1,
        stdout: `× tests/empty.test.lua (did not load)
↓ tests/skipped.test.lua (1 test, 1 skipped)

Failed: tests/empty.test.lua
  the test file has no tests

Test files: 1 failed, 1 skipped (2)
Tests: 1 skipped (1)
Duration: 0.63 s
`,
        stderr: '',
      },
    ])
  })

  it('fails without a project, with options it does not know, and shows its help', async () => {
    const usage = (await test(root, ['--help'])).stdout
    expect([
      await test(write('nothing', { 'readme.txt': '' })),
      await test(bank({}), ['--watch']),
      await test(bank({}), ['--help', 'tests']),
      await test(root, ['-h']),
      usage.split('\n')[0],
    ]).toEqual([
      {
        code: 2,
        stdout: '',
        stderr:
          'fiverunner: there is no FiveM project here: a resource has an fxmanifest.lua or a __resource.lua, and a server a resources directory\n',
      },
      { code: 2, stdout: '', stderr: `fiverunner: unknown option --watch\n\n${usage}` },
      { code: 2, stdout: '', stderr: `fiverunner: unknown option --help\n\n${usage}` },
      { code: 0, stdout: usage, stderr: '' },
      'Usage: fiverunner test [paths...]',
    ])
  })

  it('fails the files that FiveRunner fails to run', async () => {
    const directory = write('server', {
      'resources/fiverunner/fxmanifest.lua': MANIFEST,
      'tests/a.test.lua': `it('a', function() end)`,
    })
    const { code, stdout } = await test(directory)
    expect([code, stdout.split('\n\n')[1]]).toEqual([
      1,
      'Failed: tests/a.test.lua\n  FiveRunner failed to run the file: The project has a resource named fiverunner, the name of the resource that runs its tests',
    ])
  })

  it('colors what passed, failed and was skipped where the host shows colors', async () => {
    const directory = bank({
      'tests/a.test.lua': `it('a', function() end)`,
      'tests/b.test.lua': `it('b', function() error('b') end)`,
      'tests/c.test.lua': `it.skip('c', function() end)`,
    })
    const { stdout } = await test(directory, [], { color: true })
    expect(stdout.split('\n').slice(0, 4)).toEqual([
      '\x1b[32m✓\x1b[39m tests/a.test.lua \x1b[2m(1 test)\x1b[22m',
      '\x1b[31m×\x1b[39m tests/b.test.lua \x1b[2m(1 test, 1 failed)\x1b[22m',
      '   \x1b[31m×\x1b[39m b',
      '\x1b[33m↓\x1b[39m tests/c.test.lua \x1b[2m(1 test, 1 skipped)\x1b[22m',
    ])
  })
})
