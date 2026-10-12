import { describe, expect, it } from 'vitest'

import {
  clientNativesFile,
  ManifestError,
  readManifest,
  type MetadataEntry,
} from '../../src/core/engine/manifest.ts'
import { createRuntime, thrown } from '../lua/helpers.ts'

const lua = await createRuntime()

/** Reads the manifest of the resource at `path` with `files`. */
function read(files: Record<string, string>, path = 'resources/a') {
  return readManifest(lua, path, (name) => files[name])
}

/** The keys and values of entries, without where they were defined. */
function pairs(entries: readonly (readonly [string, string, unknown?])[]): string[] {
  return entries.map(([key, value]) => `${key} = ${value}`)
}

describe('readManifest', () => {
  it('adds an entry for each name called, and one for each value of a table, named without a final s', () => {
    const entries = read({
      'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
client_script 'client.lua'
server_scripts { 'a.lua', 'b.lua' }
dependencies { 'x' }
client_scripts 'plural.lua'
version(1.5)
build(2)
precision(3.0)`,
    })
    expect(pairs(entries)).toEqual([
      'fx_version = cerulean',
      'game = gta5',
      'client_script = client.lua',
      'server_script = a.lua',
      'server_script = b.lua',
      // FiveM's dependency loader reads dependencie entries for this.
      'dependencie = x',
      // A string keeps the name as it is.
      'client_scripts = plural.lua',
      // Numbers turn into strings as Lua writes them.
      'version = 1.5',
      'build = 2',
      'precision = 3.0',
      'is_cfxv2 = true',
    ])
  })

  it('records where entries were defined, after the path of the resource as FiveM does', () => {
    const entries = read(
      {
        'fxmanifest.lua': `fx_version 'cerulean'
client_scripts {
    'a.lua',
}`,
      },
      'resources//[cat]/a',
    )
    expect(entries.slice(0, 2)).toEqual([
      ['fx_version', 'cerulean', { file: 'resources//[cat]/a/a/fxmanifest.lua', line: 1 }],
      ['client_script', 'a.lua', { file: 'resources//[cat]/a/a/fxmanifest.lua', line: 2 }],
    ])
    expect(entries[2]).toEqual(['is_cfxv2', 'true'])
  })

  it('adds the JSON of what follows a value as an _extra entry', () => {
    const entries = read({
      'fxmanifest.lua': `data_file 'DLC_ITYP_REQUEST' 'stream/props.ytyp'
my_data 'value' { answer = 42 }
names { 'a' } { list = { true } }`,
    })
    expect(pairs(entries)).toEqual([
      'data_file = DLC_ITYP_REQUEST',
      'data_file_extra = "stream/props.ytyp"',
      'my_data = value',
      'my_data_extra = {"answer":42}',
      'name = a',
      'name_extra = {"list":[true]}',
      'is_cfxv2 = true',
    ])
  })

  it('runs manifests as Lua without io, os, load and the like, whose names add entries', () => {
    const entries = read({
      'fxmanifest.lua': `local scripts = { 'a.lua' }
description = 'a global, not an entry'
client_scripts(scripts)
io 'i'
os 'o'
load 'l'
dofile 'd'
loadfile 'f'
require 'r'
msgpack 'm'
AddMetaData('direct', description)
AddMetaData('IS_CFXV2', 'false')
is_cfxv2 'false'`,
    })
    expect(pairs(entries)).toEqual([
      'client_script = a.lua',
      'io = i',
      'os = o',
      'load = l',
      'dofile = d',
      'loadfile = f',
      'require = r',
      'msgpack = m',
      'direct = a global, not an entry',
      'is_cfxv2 = true',
    ])
  })

  it('reads __resource.lua when there is no fxmanifest.lua, without is_cfxv2', () => {
    expect(pairs(read({ '__resource.lua': `client_script 'a.lua'` }))).toEqual([
      'client_script = a.lua',
    ])
    expect(
      pairs(
        read({
          'fxmanifest.lua': `client_script 'new.lua'`,
          '__resource.lua': `client_script 'old.lua'`,
        }),
      ),
    ).toEqual(['client_script = new.lua', 'is_cfxv2 = true'])
  })

  it('fails without a manifest', () => {
    const error = thrown(() => readManifest(lua, 'resources/a', () => undefined))
    expect(error).toBeInstanceOf(ManifestError)
    expect(error).toMatchObject({
      message: 'Could not open resource metadata file - no such file.',
      missing: true,
    })
  })

  it('fails on manifests that do not parse, without reading __resource.lua', () => {
    const error = thrown(() =>
      readManifest(lua, 'resources/a', (name) =>
        name === 'fxmanifest.lua' ? `fx_version = = 1` : `client_script 'old.lua'`,
      ),
    )
    expect(error).toMatchObject({
      message:
        "Could not parse resource metadata file resources/a/fxmanifest.lua: a/fxmanifest.lua:1: unexpected symbol near '='",
      missing: false,
    })
  })

  it('fails on manifests that raise errors, with the traceback', () => {
    const error = thrown(() =>
      readManifest(lua, 'resources/a', () => `fx_version 'cerulean'\nerror('nope')`),
    )
    expect((error as Error).message.split('\n').slice(0, 4)).toEqual([
      'Could not execute resource metadata file resources/a/fxmanifest.lua: a/fxmanifest.lua:2: nope',
      'stack traceback:',
      "\t[C]: in function 'error'",
      "\ta/fxmanifest.lua:2: in local 'chunk'",
    ])
  })

  it('fails on values that are not strings or numbers, as luaL_checkstring does', () => {
    const message = (source: string) =>
      (thrown(() => readManifest(lua, 'resources/a', () => source)) as Error).message.split('\n')[0]
    expect(message(`lua54(true)`)).toBe(
      "Could not execute resource metadata file resources/a/fxmanifest.lua: bad argument #2 to 'addMetaData' (string expected, got boolean)",
    )
    expect(message(`files { {} }`)).toBe(
      "Could not execute resource metadata file resources/a/fxmanifest.lua: bad argument #2 to 'addMetaData' (string expected, got table)",
    )
    expect(message(`AddMetaData('key')`)).toBe(
      "Could not execute resource metadata file resources/a/fxmanifest.lua: bad argument #2 to 'AddMetaData' (string expected, got no value)",
    )
    expect(message(`AddMetaData(setmetatable({}, { __name = 'Thing' }), 'v')`)).toBe(
      "Could not execute resource metadata file resources/a/fxmanifest.lua: bad argument #1 to 'AddMetaData' (string expected, got Thing)",
    )
  })
})

describe('clientNativesFile', () => {
  const versioned = (version: string): MetadataEntry[] => [['resource_manifest_version', version]]

  it('gives the natives of the newest build that the manifest version has reached', () => {
    expect(clientNativesFile([])).toBe('natives_21e43a33.lua')
    expect(clientNativesFile(versioned('77731fab-63ca-442c-a67b-abc70f28dfa5'))).toBe(
      'natives_21e43a33.lua',
    )
    expect(clientNativesFile(versioned('f15e72ec-3972-4fe4-9c7d-afc5394ae207'))).toBe(
      'natives_0193d0af.lua',
    )
    expect(clientNativesFile(versioned('44febabe-d386-4d18-afbe-5e627f4af937'))).toBe(
      'natives_universal.lua',
    )
    // FiveM orders this one after 44febabe, which it dates later.
    expect(clientNativesFile(versioned('05cfa83c-a124-4cfa-a768-c24a5811d8f9'))).toBe(
      'natives_universal.lua',
    )
  })

  it('reads manifest versions as FiveM parses guids, from their first 36 characters', () => {
    expect(clientNativesFile(versioned('F15E72EC-3972-4FE4-9C7D-AFC5394AE207'))).toBe(
      'natives_0193d0af.lua',
    )
    expect(clientNativesFile(versioned('44febabe-d386-4d18-afbe-5e627f4af937 and more'))).toBe(
      'natives_universal.lua',
    )
    for (const version of [
      '{44febabe-d386-4d18-afbe-5e627f4af937}',
      '44febabe-d386-4d18-afbe-5e627f4af93',
      '44febabe-d386-4d18-afbe5e627f4af937',
      '44febabe-d386-4d18-afbe-5e627f4af93g',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]) {
      expect(clientNativesFile(versioned(version))).toBe('natives_21e43a33.lua')
    }
  })

  it('reads the first manifest version, with its key as written', () => {
    expect(
      clientNativesFile([
        ['resource_manifest_version', 'f15e72ec-3972-4fe4-9c7d-afc5394ae207'],
        ['resource_manifest_version', '44febabe-d386-4d18-afbe-5e627f4af937'],
      ]),
    ).toBe('natives_0193d0af.lua')
    expect(
      clientNativesFile([['RESOURCE_MANIFEST_VERSION', '44febabe-d386-4d18-afbe-5e627f4af937']]),
    ).toBe('natives_21e43a33.lua')
  })

  it('gives the universal natives for an fx_version, the first, of adamant or later', () => {
    const old = versioned('77731fab-63ca-442c-a67b-abc70f28dfa5')
    for (const version of ['adamant', 'bodacious', 'cerulean']) {
      expect(clientNativesFile([...old, ['fx_version', version]])).toBe('natives_universal.lua')
    }
    expect(clientNativesFile([['fx_version', 'zebra']])).toBe('natives_21e43a33.lua')
    expect(
      clientNativesFile([
        ['fx_version', 'zebra'],
        ['fx_version', 'cerulean'],
      ]),
    ).toBe('natives_21e43a33.lua')
    expect(
      clientNativesFile([
        ['fx_version', 'zebra'],
        ['resource_manifest_version', '44febabe-d386-4d18-afbe-5e627f4af937'],
      ]),
    ).toBe('natives_universal.lua')
  })
})
