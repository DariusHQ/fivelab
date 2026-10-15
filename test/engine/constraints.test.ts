import { describe, expect, it } from 'vitest'

import {
  Constraints,
  FIVEM_BUILD,
  parseGameBuild,
  type ConstraintResult,
} from '../../src/core/engine/index.ts'
import server from '../../src/core/natives/catalog/server.json' with { type: 'json' }
import { createProcess, type ProcessOptions, type TestProcess } from './helpers.ts'

describe('constraints', () => {
  it('test flags, strings and numbers as FiveM does', () => {
    const constraints = new Constraints()
    constraints.register('on', true)
    constraints.register('off', false)
    constraints.register('name', 'fiverunner')
    constraints.register('build', 100)
    const cases: [string, ConstraintResult][] = [
      ['', 'none'],
      ['on', 'none'],
      ['/on', 'pass'],
      ['/on:true', 'pass'],
      ['/on:false', { error: 'on needs to be disabled' }],
      ['/on:yes', { error: "yes isn't a boolean" }],
      ['/on:', { error: 'constraint syntax error' }],
      ['/off', { error: "off isn't enabled" }],
      ['/off:true', { error: 'off needs to be enabled' }],
      ['/off:false', 'pass'],
      ['/name', 'pass'],
      ['/name:fiverunner', 'pass'],
      ['/name:FiveRunner', { error: 'name needs to be FiveRunner' }],
      ['/build', 'pass'],
      ['/build:100', 'pass'],
      ['/build:-5', 'pass'],
      // Numbers are read as C's atoi reads them.
      ['/build:99x', 'pass'],
      ['/build:x99', 'pass'],
      ['/build:101', { error: 'build needs to be 101 or higher' }],
      ['/build:99999999999', { error: 'build needs to be 2147483647 or higher' }],
      ['/Build:1', { error: "constraint 'Build' is unknown" }],
      ['/on/off', { error: "constraint 'on/off' is unknown" }],
      ['/build:1:2', { error: 'constraint syntax error' }],
      ['/build:1.5', { error: 'constraint syntax error' }],
    ]
    constraints.enforcing = true
    expect(cases.map(([expression]) => [expression, constraints.match(expression)])).toEqual(cases)
    // Unless they are enforced, constraints that fail pass.
    constraints.enforcing = false
    expect(cases.map(([expression]) => [expression, constraints.match(expression)])).toEqual(
      cases.map(([expression, result]) => [expression, result === 'none' ? 'none' : 'pass']),
    )
  })

  it("are those of FiveM's server on servers: its build, OneSync, the game build and natives", async () => {
    const cases: [ProcessOptions, string, ConstraintResult][] = [
      [{}, '/server', 'pass'],
      [{}, '/server:5181', 'pass'],
      [{}, `/server:${FIVEM_BUILD}`, 'pass'],
      [
        {},
        `/server:${FIVEM_BUILD + 1}`,
        { error: `server needs to be ${FIVEM_BUILD + 1} or higher` },
      ],
      [{}, '/onesync', 'pass'],
      // FiveM tests OneSync whatever the value.
      [{}, '/onesync:false', 'pass'],
      [{ oneSync: false }, '/onesync', { error: 'onesync: ^1OneSync needs to be enabled^7' }],
      [
        { oneSync: false },
        '/onesync:true',
        { error: 'onesync(true): ^1OneSync needs to be enabled^7' },
      ],
      [{}, '/gameBuild:3258', 'pass'],
      [{}, '/gameBuild:h4', 'pass'],
      [{}, '/gameBuild:mp2024_01', 'pass'],
      [
        {},
        '/gameBuild:mp2025_01',
        {
          error:
            'gameBuild(mp2025_01): ^1sv_enforceGameBuild needs to be at least 3570 (current is 3258)^7',
        },
      ],
      [{ gameBuild: 3570 }, '/gameBuild:mp2025_01', 'pass'],
      [{}, '/gameBuild:nonsense', { error: 'gameBuild(nonsense): ^1no details specified^7' }],
      [{}, '/gameBuild', { error: 'gameBuild: ^1no details specified^7' }],
      [{ gameBuild: 0 }, '/gameBuild:h4', { error: 'gameBuild(h4): ^1no details specified^7' }],
      [{}, '/native:0xE5E9EBBB', 'pass'],
      [{}, '/native:0x00000000e5e9ebbb', 'pass'],
      // Hashes are read as C's strtoull reads them.
      [{}, '/native:0x0xe5e9ebbb', 'pass'],
      [{}, '/native:0xe5e9ebbb_old', 'pass'],
      [{}, '/native:0x1', { error: "native(0x1): ^1native 0x1 isn't supported^7" }],
      [
        {},
        '/native:0x-1',
        { error: "native(0x-1): ^1native 0xFFFFFFFFFFFFFFFF isn't supported^7" },
      ],
      [
        {},
        '/native:0x123456789abcdef01',
        { error: "native(0x123456789abcdef01): ^1native 0xFFFFFFFFFFFFFFFF isn't supported^7" },
      ],
      [{}, '/native:0xz', { error: "native(0xz): ^1native 0x0 isn't supported^7" }],
      [{}, '/native:0x', { error: 'native(0x): ^1no details specified^7' }],
      [{}, '/native:0XE5E9EBBB', { error: 'native(0XE5E9EBBB): ^1no details specified^7' }],
      [{}, '/native', { error: 'native: ^1no details specified^7' }],
      [{}, '/unknown', { error: "constraint 'unknown' is unknown" }],
    ]
    const processes = new Map<string, TestProcess>()
    const results: [ProcessOptions, string, ConstraintResult][] = []
    for (const [options, expression] of cases) {
      const key = JSON.stringify(options)
      const proc = processes.get(key) ?? (await createProcess(options))
      processes.set(key, proc)
      results.push([options, expression, proc.manager.constraints.match(expression)])
    }
    expect(results).toEqual(cases)
  })

  it('are not enforced on clients', async () => {
    const { manager } = await createProcess({ side: 'client' })
    expect(manager.constraints.enforcing).toBe(false)
    expect(
      ['/server:99999', '/onesync', '/unknown', '/server:1:2'].map((expression) =>
        manager.constraints.match(expression),
      ),
    ).toEqual(['pass', 'pass', 'pass', 'pass'])
  })

  it('read game builds as FiveM does', () => {
    const cases: [string, number | undefined][] = [
      ['2189', 2189],
      ['-5', -5],
      // FiveM takes numbers it does not write the same way for names.
      ['007', undefined],
      ['+5', undefined],
      ['mpheist4', 2189],
      ['heist4', 2189],
      ['h4', 2189],
      ['xm18', 1604],
      ['mpchristmas2018', 1604],
      ['sum', 2060],
      ['mpSUM2', 2699],
      ['MPSUM2', undefined],
      ['mp2026_01', 3889],
      ['', undefined],
      ['mp', undefined],
    ]
    expect(cases.map(([value]) => [value, parseGameBuild(value)])).toEqual(cases)
  })

  it('follow the build of FiveM that the natives come from', () => {
    expect(server.source).toBe(`@citizenfx/server@2.0.${FIVEM_BUILD}-1`)
  })
})
