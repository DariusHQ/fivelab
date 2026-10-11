import { describe, expect, it } from 'vitest'

import { LuaVector } from '../../src/core/lua/index.ts'
import { defineNative, hashString, type NativeDefinition } from '../../src/core/natives/index.ts'
import type { ScriptRuntime } from '../../src/core/scripting/runtime.ts'
import { createResource } from '../scripting/helpers.ts'

type Native = NativeDefinition<ScriptRuntime>

const getHashKey = defineNative(
  { name: 'GET_HASH_KEY', hash: 0xd24d37cc275948ccn, result: 'Hash', params: ['char* string'] },
  (_ctx, string) => (string === null ? 0 : hashString(string)),
)

const describeNative = defineNative(
  {
    name: 'DESCRIBE',
    result: 'char*',
    params: ['char* text', 'Hash model', 'func callback', 'object data', 'int end'],
  },
  (_ctx, text, model, callback, data, end) =>
    JSON.stringify([text, model, callback, Array.from(data), end]),
)

const values = defineNative(
  {
    name: 'GET_VALUES',
    result: 'BOOL',
    params: ['int input', 'int* count', 'float* scale', 'Vector3* where'],
    aliases: ['_GET_THE_VALUES', '_0x1234567890ABCDEF'],
  },
  (_ctx, input, count, scale, where) => {
    count.set(input * 2)
    scale.set(0.5)
    where.set(new LuaVector('vector3', 1, 2, 3))
    return input > 0
  },
)

const counter = defineNative(
  { name: 'INCREMENT', result: 'void', params: ['int* value'] },
  (_ctx, value) => value.set(value.get() + 1),
)

const heading = defineNative({ name: 'GET_HEADING', result: 'float', params: [] }, () => 90)

const natives: Native[] = [getHashKey, describeNative, values, counter, heading]

async function resource() {
  return createResource({ natives })
}

describe('natives in _G', () => {
  it('load on first use and stay', async () => {
    const res = await resource()
    res.run(`print(rawget(_G, 'GetHeading'))
print(GetHeading(), math.type(GetHeading()))
print(type(rawget(_G, 'GetHeading')))`)
    expect(res.take()).toBe('nil\n90.0\tfloat\nfunction\n')
    expect(res.loads.filter((name) => name === 'GetHeading')).toEqual(['GetHeading'])
  })

  it('are looked up once for names no native has', async () => {
    const res = await resource()
    res.run(`print(NotANative, NotANative, _G.NotANative)
print(pcall(function() NotANative() end))`)
    expect(res.take()).toBe(
      "nil\tnil\tnil\nfalse\t@test/client.lua:2: attempt to call a nil value (global 'NotANative')\n",
    )
    expect(res.loads.filter((name) => name === 'NotANative')).toEqual(['NotANative'])
  })

  it('make lookups of missing globals with keys that are no names fail, as in FiveM', async () => {
    const res = await resource()
    res.run(`print(_G[1])
print(pcall(function() return _G[true] end))`)
    expect(res.take()).toBe(
      "nil\nfalse\tbad argument #1 to 'LoadNative' (string expected, got boolean)\n",
    )
  })

  it('include aliases, each loaded on its own', async () => {
    const res = await resource()
    res.run(`print(rawget(_G, 'GetValues'), GetTheValues(1))
print(N_0x1234567890abcdef(1) == 1)`)
    expect(res.take()).toBe('nil\t1\t2\t0.5\tvec3(1.000000, 2.000000, 3.000000)\ntrue\n')
  })
})

describe('native functions', () => {
  it('return the result, then out-pointers', async () => {
    const res = await resource()
    res.run(`print(GetValues(3))
print(GetValues(-3))`)
    expect(res.take()).toBe(
      '1\t6\t0.5\tvec3(1.000000, 2.000000, 3.000000)\n' +
        'false\t-6\t0.5\tvec3(1.000000, 2.000000, 3.000000)\n',
    )
  })

  it('take the initial value of a single pointer', async () => {
    const res = await resource()
    res.run(`print(Increment(41), Increment())`)
    expect(res.take()).toBe('42\t1\n')
  })

  it('convert strings, hashes, functions and objects as FiveM does', async () => {
    const res = await resource()
    res.run(`Citizen.GetFunctionReference = function(fn) return 'ref:' .. type(fn) end
print(Describe('text', 'adder', print, {1, 2}, 4))
print(Describe(12, 5, nil, 'x', nil))
print(Describe(0, nil, nil, nil, nil))
print(Describe(false, nil, nil, nil, nil))`)
    const adder = hashString('adder')
    expect(res.take()).toBe(
      [
        `["text",${adder},"ref:function",[146,1,2],4]`,
        '["12",5,"ref:nil",[161,120],0]',
        '[null,0,"ref:nil",[192],0]',
        '[null,0,"ref:nil",[192],0]',
        '',
      ].join('\n'),
    )
  })

  it('look up GetHashKey and Citizen.GetFunctionReference when they run', async () => {
    const res = await resource()
    res.run(`GetHashKey = function(name) return #name end
Citizen.GetFunctionReference = function() return nil end
print(Describe(nil, 'adder', print, nil, nil))`)
    expect(res.take()).toBe('[null,5,null,[192],0]\n')
  })
})
