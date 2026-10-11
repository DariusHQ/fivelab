import { describe, expect, it } from 'vitest'

import {
  catalogNatives,
  defineNative,
  hashString,
  NativeError,
  NativeRegistry,
  type Side,
} from '../../src/core/natives/index.ts'
import type { ScriptRuntime } from '../../src/core/scripting/runtime.ts'
import { createResource } from '../scripting/helpers.ts'

function registry(side: Side): NativeRegistry<ScriptRuntime> {
  const natives = new NativeRegistry<ScriptRuntime>()
  natives.register(...catalogNatives<ScriptRuntime>(side))
  return natives
}

describe('the catalog', () => {
  it('has each native once, under its names', () => {
    for (const side of ['client', 'server'] as const) {
      const natives = catalogNatives<ScriptRuntime>(side)
      const registered = registry(side)
      expect(registered.size).toBe(natives.length)
      for (const native of natives) {
        for (const name of [native.luaName, ...native.aliases]) {
          expect(registered.byName(name)?.hash).toBe(native.hash)
        }
      }
    }
  })

  it('has CFX natives under the hashes of their names', () => {
    const client = registry('client')
    const server = registry('server')
    expect(client.byName('GetCurrentResourceName')).toMatchObject({
      hash: BigInt(hashString('GET_CURRENT_RESOURCE_NAME')),
      result: 'char*',
      params: [],
    })
    expect(server.byName('TriggerClientEventInternal')?.hash).toBe(
      BigInt(hashString('TRIGGER_CLIENT_EVENT_INTERNAL')),
    )
    expect(client.byName('TriggerClientEventInternal')).toBeUndefined()
  })

  it('has game natives under the hashes in their N_0x names', () => {
    const client = registry('client')
    const slowmo = client.byHash(0xd01005d2ba2eb778n)
    expect(slowmo?.luaName).toBe('ActivateAudioSlowmoMode')
    expect(client.byName('N_0xd01005d2ba2eb778')).toBe(slowmo)
    // The CFX native GET_PED_EYE_COLOR came after the game native of that
    // name, which only keeps its N_0x name, as FiveM writes their Lua files.
    expect(client.byName('GetPedEyeColor')?.hash).toBe(BigInt(hashString('GET_PED_EYE_COLOR')))
    expect(client.byHash(0x76bba2cee66d47e9n)?.luaName).toBe('N_0x76bba2cee66d47e9')
  })
})

describe('natives FiveLab does not implement', () => {
  it('do nothing and return zero values of their kinds, saying so once', async () => {
    const res = await createResource({ catalog: true, client: true })
    res.run(`local ped = PlayerPedId()
print(ped, GetEntityCoords(ped, true), IsPedInAnyVehicle(ped, false))
print(GetScreenCoordFromWorldCoord(1.0, 2.0, 3.0))
print(GetPlayerName(PlayerId()), GetEntityCoords(ped, true))`)
    expect(res.take()).toBe(
      '0\tvec3(0.000000, 0.000000, 0.000000)\tfalse\n' +
        'false\t0\t0\n' +
        'nil\tvec3(0.000000, 0.000000, 0.000000)\n',
    )
    expect(res.diagnostics).toEqual(
      [
        'PlayerPedId',
        'GetEntityCoords',
        'IsPedInAnyVehicle',
        'GetScreenCoordFromWorldCoord',
        'PlayerId',
        'GetPlayerName',
      ].map(
        (name) =>
          `${name} is not implemented in FiveLab yet: it does nothing and returns zero values.`,
      ),
    )
  })

  it('all run without errors, returning as many values as FiveM', async () => {
    for (const side of ['client', 'server'] as const) {
      const res = await createResource({ catalog: true, client: side === 'client' })
      const natives = catalogNatives<ScriptRuntime>(side)
      const counts = new Map<string, number>()
      for (const native of natives) {
        // The result, which void natives without out-pointers return as false, then the out-pointers.
        const pointers = native.params.filter(
          ({ type }) => type.endsWith('*') && type !== 'char*',
        ).length
        const count = native.result === 'void' ? Math.max(pointers, 1) : pointers + 1
        for (const name of [native.luaName, ...native.aliases]) counts.set(name, count)
      }
      const names = [...counts.keys()]
      const [list] = res.script.state.run(`return {...}`, '=names', ...names)
      res.script.state.setGlobal('names', list!)
      res.run(`Citizen.GetFunctionReference = function() end
local defined, returned = {}, {}
for _, name in ipairs(names) do
    if rawget(_G, name) == nil then
        returned[#returned + 1] = name .. '=' .. select('#', _G[name]())
    else
        defined[#defined + 1] = name
    end
end
print(table.concat(defined, ' '))
print(table.concat(returned, ' '))`)
      const [defined, returned] = res.take().split('\n')
      // The script runtime defines Wait instead of the native WAIT, as FiveM's does.
      const replaced = side === 'client' ? ['Wait'] : []
      expect(defined).toBe(replaced.join(' '))
      expect(returned!.split(' ')).toEqual(
        names
          .filter((name) => !replaced.includes(name))
          .map((name) => `${name}=${counts.get(name)}`),
      )
    }
  })
})

describe('natives FiveLab implements', () => {
  it('replace natives of the catalog, keeping their names and documentation lines', () => {
    const natives = registry('client')
    const stub = natives.byName('GetEntityCoords')!
    natives.register(
      defineNative(
        {
          name: 'GET_ENTITY_COORDS',
          hash: 0x3fef770d40960d5an,
          result: 'Vector3',
          params: ['Entity entity', 'BOOL alive'],
        },
        () => ({ x: 1, y: 2, z: 3 }),
      ),
    )
    const native = natives.byName('GetEntityCoords')!
    expect(native.impl).not.toBeNull()
    expect(native.hash).toBe(0x3fef770d40960d5an)
    expect(native.docLines).toBe(stub.docLines)
    expect(natives.byHash(stub.hash)).toBeUndefined()
    expect(natives.byHash(0x3fef770d40960d5an)).toBe(native)
  })

  it('cannot have the hash of one native and a name of another', () => {
    const natives = registry('client')
    const gameEyeColor = defineNative(
      { name: '_GET_PED_EYE_COLOR', hash: 0x76bba2cee66d47e9n, result: 'int', params: ['Ped ped'] },
      () => 0,
    )
    expect(() => natives.register(gameEyeColor)).toThrow(
      'GetPedEyeColor (0x76bba2cee66d47e9) has the hash of N_0x76bba2cee66d47e9 and a name of GetPedEyeColor',
    )
  })

  it('run at the lines of FiveM', async () => {
    const fail = {
      ...defineNative({ name: 'FAIL', result: 'void', params: [] }, () => {
        throw new NativeError('failed')
      }),
      docLines: 3,
    }
    for (const [client, line] of [
      [true, 6],
      [false, 5],
    ] as const) {
      const res = await createResource({ natives: [fail], client })
      // Level 3 of the handler is the function that called the native's C function.
      res.run(`xpcall(function() Fail() end, function(err)
    local caller = debug.getinfo(3, 'Sln')
    print(err, caller.name, caller.short_src, caller.currentline)
end)`)
      expect(res.take()).toBe(
        `native 00000000${hashString('FAIL').toString(16)}: failed\tFail\tFail.lua\t${line}\n`,
      )
    }
  })
})
