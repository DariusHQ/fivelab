import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findTestFiles, openProject } from '../../src/node/project.ts'
import { runFile } from '../../src/runner/index.ts'
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

const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes)

const MANIFEST = `fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server.lua'`

describe('Projects', () => {
  it('are resources, which servers of tests ensure, when they have a manifest', () => {
    const bank = openProject(write('bank', { 'fxmanifest.lua': MANIFEST, 'server.lua': '' }))!
    const old = openProject(write('old', { '__resource.lua': '' }))!
    const files = bank.files()
    expect([bank.kind, bank.name, bank.commands, old.kind, old.commands]).toEqual([
      'resource',
      'bank',
      ['ensure "bank"'],
      'resource',
      ['ensure "old"'],
    ])
    expect(decode(files.read('resources/bank/fxmanifest.lua'))).toBe(MANIFEST)
    // Each server of a test gets files of its own.
    files.write('resources/bank/server.lua', new TextEncoder().encode('changed'))
    expect(decode(bank.files().read('resources/bank/server.lua'))).toBe('')
  })

  it('are servers, which exec their server.cfg if they have one, when they have a resources directory', () => {
    const server = openProject(
      write('server', { 'server.cfg': 'ensure bank', 'resources/bank/fxmanifest.lua': MANIFEST }),
    )!
    const bare = openProject(write('bare', { 'resources/readme.txt': '' }))!
    expect([server.kind, server.name, server.commands, bare.kind, bare.commands]).toEqual([
      'server',
      undefined,
      ['exec server.cfg'],
      'server',
      [],
    ])
    expect(decode(server.files().read('resources/bank/fxmanifest.lua'))).toBe(MANIFEST)
  })

  it('are neither without a manifest or a resources directory', () => {
    const none = write('none', {
      'readme.txt': '',
      resources: '',
      'server.cfg': '',
      'FXManifest.lua': '',
    })
    expect(openProject(none)).toBe(undefined)
  })

  it('keep their test files from the servers of tests', () => {
    const bank = openProject(
      write('bank', {
        'fxmanifest.lua': MANIFEST,
        'tests/a.test.lua': '',
        'tests/helper.lua': '',
        // Directories are no test files, whatever their names.
        'tests/data.test.lua/x.txt': '',
      }),
    )!
    const files = bank.files()
    const listed = files.list('resources/bank/tests')!.map(({ name }) => name)
    expect([listed.sort(), decode(bank.source.read('tests/a.test.lua'))]).toEqual([
      ['data.test.lua', 'helper.lua'],
      '',
    ])
  })

  it('run the tests of a resource with the resource ensured', async () => {
    const bank = openProject(
      write('bank', {
        'fxmanifest.lua': MANIFEST,
        'server.lua': `exports('balance', function() return 500 end)`,
        'tests/bank.test.lua': `it('gives balances', function()
    expect(exports.bank:balance()).toBe(500)
    expect(LoadResourceFile('bank', 'tests/bank.test.lua')).toBeNil()
end)`,
      }),
    )!
    const path = 'tests/bank.test.lua'
    const result = await runFile(
      { path, source: bank.source.read(path) },
      { cfxlua: await cfxlua(), project: bank },
    )
    expect(result.tests.map(({ status, failures }) => [status, failures])).toEqual([['passed', []]])
  })
})

describe('findTestFiles', () => {
  it('finds the files that end in .test.lua, in the order of their bytes, but in node_modules and hidden directories', () => {
    const project = openProject(
      write('server', {
        'resources/bank/fxmanifest.lua': '',
        'resources/bank/tests/b.test.lua': '',
        'resources/bank/tests/a.test.lua': '',
        'resources/bank/tests/helper.lua': '',
        'resources/bank/node_modules/x/x.test.lua': '',
        'resources/bank/.git/y.test.lua': '',
        'Z.test.lua': '',
        'tests/test.lua': '',
        'tests/.test.lua': '',
      }),
    )!
    expect([
      findTestFiles(project.source),
      findTestFiles(project.source, 'resources/bank'),
    ]).toEqual([
      [
        'Z.test.lua',
        'resources/bank/tests/a.test.lua',
        'resources/bank/tests/b.test.lua',
        'tests/.test.lua',
      ],
      ['resources/bank/tests/a.test.lua', 'resources/bank/tests/b.test.lua'],
    ])
  })
})
