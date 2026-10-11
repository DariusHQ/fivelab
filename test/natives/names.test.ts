import { describe, expect, it } from 'vitest'

import { declaredName, hashInName, hashString, luaName } from '../../src/core/natives/index.ts'

describe('hashString', () => {
  it('gives the hashes of CFX natives', () => {
    expect(hashString('TRIGGER_EVENT_INTERNAL')).toBe(0x91310870)
    expect(hashString('GET_CURRENT_RESOURCE_NAME')).toBe(0xe5e9ebbb)
    expect(hashString('REGISTER_RESOURCE_AS_EVENT_HANDLER')).toBe(0xd233a168)
  })

  it('ignores ASCII case, as GetHashKey does', () => {
    expect(hashString('adder')).toBe(0xb779a091)
    expect(hashString('ADDER')).toBe(0xb779a091)
  })

  it('stops at the first NUL', () => {
    expect(hashString('adder\0suffix')).toBe(hashString('adder'))
  })

  it('takes bytes past ASCII as signed chars, as FiveM does', () => {
    // The UTF-8 bytes 0xc3 0xa9 add -61 and -87, not 195 and 169.
    expect(hashString('é')).toBe(hashString(new Uint8Array([0xc3, 0xa9])))
    expect(hashString('é')).toBe(0x019148ae) // what CfxLua's joaat('é') gives
  })
})

describe('luaName', () => {
  it('turns declared names into the globals Lua calls', () => {
    expect(luaName('GET_ENTITY_COORDS')).toBe('GetEntityCoords')
    expect(luaName('GET_GROUND_Z_FOR_3D_COORD')).toBe('GetGroundZFor_3dCoord')
    expect(luaName('_GET_PED_SOMETHING')).toBe('GetPedSomething')
    expect(luaName('_0xD01005D2BA2EB778')).toBe('N_0xd01005d2ba2eb778')
  })

  it('reverses with declaredName for names in capitals', () => {
    for (const name of [
      'TRIGGER_EVENT_INTERNAL',
      'GET_GROUND_Z_FOR_3D_COORD',
      'IS_PED_IN_ANY_VEHICLE',
    ]) {
      expect(declaredName(luaName(name))).toBe(name)
    }
  })
})

describe('hashInName', () => {
  it('reads the hash of an unnamed native', () => {
    expect(hashInName('N_0xd01005d2ba2eb778')).toBe(0xd01005d2ba2eb778n)
    expect(hashInName('GetEntityCoords')).toBeUndefined()
  })
})
