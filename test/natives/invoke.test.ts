import { describe, expect, it } from 'vitest'

import { LuaVector } from '../../src/core/lua/index.ts'
import { defineNative, NativeError, type NativeDefinition } from '../../src/core/natives/index.ts'
import type { ScriptRuntime } from '../../src/core/scripting/runtime.ts'
import { createResource } from '../scripting/helpers.ts'

type Native = NativeDefinition<ScriptRuntime>

/** Runs `source` with `natives` and returns what it printed. */
async function run(source: string, natives: readonly Native[] = [], client = false) {
  const res = await createResource({ natives, client })
  res.run(source)
  return { output: res.take(), log: res.log, diagnostics: res.diagnostics }
}

/** Records the raw 64-bit slots of up to eight arguments. */
function slotRecorder(seen: (number | bigint)[][]): Native {
  return defineNative(
    {
      name: 'RECORD_SLOTS',
      hash: 0x1000n,
      result: 'void',
      params: ['long a', 'long b', 'long c', 'long d', 'long e', 'long f', 'long g', 'long h'],
    },
    (_ctx, ...slots) => {
      seen.push(slots)
    },
  )
}

describe('argument slots', () => {
  it('hold values as FiveM passes them to natives', async () => {
    const seen: (number | bigint)[][] = []
    await run(
      `Citizen.InvokeNative(0x1000, nil, false, true, -1, 1.5, -2.5, 0x7fffffffffffffff, 0.0)`,
      [slotRecorder(seen)],
    )
    expect(seen).toEqual([[0, 0, 1, -1, 0x3fc0_0000, 0xc020_0000, 0x7fff_ffff_ffff_ffffn, 0]])
  })

  it('take one float per vector component', async () => {
    const seen: (number | bigint)[][] = []
    await run(
      `Citizen.InvokeNative(0x1000, vec(1, 2), vec(3, 4, 5), 9)
Citizen.InvokeNative(0x1000, vec(1, 2, 3, 4), quat(1, 2, 3, 4))`,
      [slotRecorder(seen)],
    )
    const f = (value: number) => new Uint32Array(new Float32Array([value]).buffer)[0]!
    expect(seen).toEqual([
      [f(1), f(2), f(3), f(4), f(5), 9, 0, 0],
      [f(1), f(2), f(3), f(4), f(2), f(3), f(4), f(1)],
    ])
  })

  it('take the __data of tables', async () => {
    const seen: (number | bigint)[][] = []
    await run(
      `local field = {__data = 7}
local meta = setmetatable({}, {__data = 8})
local call = setmetatable({value = 9}, {__data = function(self) return self.value end})
Citizen.InvokeNative(0x1000, field, meta, call, {__data = true})`,
      [slotRecorder(seen)],
    )
    expect(seen).toEqual([[7, 8, 9, 1, 0, 0, 0, 0]])
  })

  it('reject values natives cannot take', async () => {
    const { output, log } = await run(
      `-- Light userdata that is no marker: scripts only find the await sentinel in Citizen.Await.
local sentinel
for i = 1, math.huge do
    local name, value = debug.getupvalue(Citizen.Await, i)
    if not name then break end
    if type(value) == 'userdata' then sentinel = value end
end
print(pcall(Citizen.InvokeNative, 0x1000, print))
print(pcall(Citizen.InvokeNative, 0x1000, {}))
print(pcall(Citizen.InvokeNative, 0x1000, {__data = {}}))
print(pcall(Citizen.InvokeNative, 0x1000, setmetatable({}, {__data = {}})))
print(pcall(Citizen.InvokeNative, 0x1000, sentinel))
print(pcall(Citizen.InvokeNative, 0x1000, coroutine.create(print)))`,
      [slotRecorder([])],
    )
    expect(output).toBe(
      [
        'false\tnative 0000000000001000: invalid lua type: function',
        'false\tnative 0000000000001000: invalid table argument',
        // A __data field that is a table does not count, so FiveM looks for a metafield.
        'false\tnative 0000000000001000: invalid table argument',
        'false\tnative 0000000000001000: invalid lua type in __data',
        'false\tnative 0000000000001000: unknown userdata pointer',
        'false\tnative 0000000000001000: invalid lua type: thread',
        '',
      ].join('\n'),
    )
    expect(log[0]).toBe(
      '[citizen-scripting-core] script error in native 0000000000001000: invalid lua type: function\n',
    )
  })

  it('are limited to 32, and out-pointers to 15', async () => {
    const { output } = await run(
      `local many = {}
for i = 1, 33 do many[i] = i end
print(pcall(Citizen.InvokeNative, 0x1000, table.unpack(many)))
print(pcall(Citizen.InvokeNative, 0x1000, table.unpack(many, 1, 32)))
local pointers = {}
for i = 1, 16 do pointers[i] = Citizen.PointerValueInt() end
print(pcall(Citizen.InvokeNative, 0x1000, table.unpack(pointers)))
print(select('#', Citizen.InvokeNative(0x1000, table.unpack(pointers, 1, 15))))`,
      [slotRecorder([])],
    )
    expect(output).toBe(
      [
        'false\tnative 0000000000001000: too many arguments',
        'true\tfalse',
        'false\tnative 0000000000001000: too many return value arguments',
        '15',
        '',
      ].join('\n'),
    )
  })
})

describe('typed arguments', () => {
  const describeArgs = defineNative(
    {
      name: 'DESCRIBE_ARGS',
      hash: 0x2000n,
      result: 'char*',
      params: ['int i', 'Hash h', 'float f', 'BOOL b', 'bool c', 'char* s', 'Vector3 v'],
    },
    (_ctx, i, h, f, b, c, s, v) => JSON.stringify([i, h, f, b, c, s, [v.x, v.y, v.z]]),
  )

  it('read their slots by type', async () => {
    const { output } = await run(
      `print(Citizen.InvokeNative(0x2000, -5, -1, 0.5, 2, 256, 'text', vec(1, 2, 3), Citizen.ResultAsString()))
print(Citizen.InvokeNative(0x2000, nil, nil, nil, nil, nil, nil, nil, Citizen.ResultAsString()))`,
      [describeArgs],
    )
    expect(output).toBe(
      '[-5,4294967295,0.5,true,false,"text",[1,2,3]]\n[0,0,0,false,false,null,[0,0,0]]\n',
    )
  })

  it('read missing arguments as 0', async () => {
    const { output } = await run(
      `print(Citizen.InvokeNative(0x2000, 1, Citizen.ResultAsString()))`,
      [describeArgs],
    )
    expect(output).toBe('[1,0,0,false,false,null,[0,0,0]]\n')
  })

  it('end strings at their first NUL', async () => {
    const { output } = await run(
      String.raw`print(Citizen.InvokeNative(0x2000, 0, 0, 0, 0, 0, 'a\0b', vec(0, 0, 0), Citizen.ResultAsString()))`,
      [describeArgs],
    )
    expect(output).toContain('"a"')
  })

  it('read integers as floats bit for bit, and say so', async () => {
    const { output, diagnostics } = await run(
      `print(Citizen.InvokeNative(0x2000, 2.0, 0, 100, 0, 0, '', vec(0, 0, 0), Citizen.ResultAsString()))`,
      [describeArgs],
    )
    expect(output).toBe('[1073741824,0,1.401298464324817e-43,false,false,"",[0,0,0]]\n')
    expect(diagnostics).toEqual([
      'DESCRIBE_ARGS: argument 1 (i) is an integer, but the script passed the float 2.0, which FiveM reads as 1073741824. Pass an integer instead.',
      'DESCRIBE_ARGS: argument 3 (f) is a float, but the script passed the integer 100, which FiveM reads as 1.401298e-43. Write 100.0 instead.',
    ])
  })

  it('must be pointers and strings where natives expect them', async () => {
    const { output } = await run(
      `print(pcall(Citizen.InvokeNative, 0x2000, 0, 0, 0, 0, 0, 5, vec(0, 0, 0)))
print(pcall(Citizen.InvokeNative, 0x2000, 0, 0, 0, 0, 0, Citizen.PointerValueInt(), vec(0, 0, 0)))`,
      [describeArgs],
    )
    expect(output).toBe(
      'false\tnative 0000000000002000: arg[5]: expected pointer, got non-zero integer\n' +
        'false\tnative 0000000000002000: arg[5]: expected string\n',
    )
  })

  it('replace pointers passed as values', async () => {
    const { output } = await run(
      `print(Citizen.InvokeNative(0x2000, 'text', 0, 0, 0, 0, '', vec(0, 0, 0), Citizen.ResultAsString()))`,
      [describeArgs],
    )
    expect(output).toBe('[2146290430,0,0,false,false,"",[0,0,0]]\n')
  })

  it('check buffers against their length', async () => {
    const buffer = defineNative(
      { name: 'TAKE_BUFFER', hash: 0x2100n, result: 'int', params: ['buffer data', 'int length'] },
      (_ctx, data) => data?.length ?? -1,
    )
    const { output } = await run(
      String.raw`print(Citizen.InvokeNative(0x2100, 'a\0b', 3, Citizen.ResultAsInteger()))
print(Citizen.InvokeNative(0x2100, 'abc', 2, Citizen.ResultAsInteger()))
print(pcall(Citizen.InvokeNative, 0x2100, 'abc', 4))`,
      [buffer],
    )
    expect(output).toBe(
      '3\n2\nfalse\tnative 0000000000002100: arg[0]: buffer length too large (4 > 3)\n',
    )
  })

  it('give the bytes of strings, past their NULs, to natives that read them as bytes', async () => {
    const bytes = defineNative(
      { name: 'TAKE_BYTES', hash: 0x2101n, result: 'char*', params: ['bytes data'] },
      (_ctx, data) => (data === null ? 'NULL' : `[${data.join(',')}]`),
    )
    const { output } = await run(
      String.raw`print(Citizen.InvokeNative(0x2101, 'a\0b\255', Citizen.ResultAsString()))
print(Citizen.InvokeNative(0x2101, '', Citizen.ResultAsString()))
print(Citizen.InvokeNative(0x2101, nil, Citizen.ResultAsString()))
print(pcall(Citizen.InvokeNative, 0x2101, 1))
print(pcall(Citizen.InvokeNative, 0x2101, Citizen.PointerValueInt()))`,
      [bytes],
    )
    expect(output).toBe(
      '[97,0,98,255]\n[]\nNULL\n' +
        'false\tnative 0000000000002101: arg[0]: expected pointer, got non-zero integer\n' +
        'false\tnative 0000000000002101: arg[0]: expected string\n',
    )
  })

  it('give objects as the bytes their length takes, and NULL as null', async () => {
    const object = defineNative(
      { name: 'TAKE_OBJECT', hash: 0x2102n, result: 'char*', params: ['object data'] },
      (_ctx, data) => (data === null ? 'NULL' : `[${data.join(',')}]`),
    )
    const { output } = await run(
      String.raw`print(Citizen.InvokeNative(0x2102, 'a\0bc', 3, Citizen.ResultAsString()))
print(Citizen.InvokeNative(0x2102, '', 0, Citizen.ResultAsString()))
print(Citizen.InvokeNative(0x2102, nil, 0, Citizen.ResultAsString()))`,
      [object],
    )
    expect(output).toBe('[97,0,98]\n[]\nNULL\n')
  })
})

describe('results', () => {
  const values = defineNative(
    { name: 'GET_VALUE', hash: 0x3000n, result: 'int', params: ['int value'] },
    (_ctx, value) => value,
  )
  const isPositive = defineNative(
    { name: 'IS_POSITIVE', hash: 0x3001n, result: 'BOOL', params: ['int value'] },
    (_ctx, value) => value > 0,
  )
  const half = defineNative(
    { name: 'GET_HALF', hash: 0x3002n, result: 'float', params: ['float value'] },
    (_ctx, value) => value / 2,
  )
  const name = defineNative(
    { name: 'GET_NAME', hash: 0x3003n, result: 'char*', params: ['int which'] },
    (_ctx, which) => [null, 'name', 'with\0nul', new Uint8Array([97, 0, 98])][which] ?? null,
  )
  const position = defineNative(
    { name: 'GET_POSITION', hash: 0x3004n, result: 'Vector3', params: [] },
    () => new LuaVector('vector3', 1, 2, 3),
  )
  const list = defineNative(
    { name: 'GET_LIST', hash: 0x3005n, result: 'object', params: [] },
    () => new Uint8Array([0x93, 0x01, 0x02, 0x03]),
  )
  const big = defineNative(
    { name: 'GET_BIG', hash: 0x3006n, result: 'long', params: [] },
    () => 0x1_0000_0001n,
  )
  const all = [values, isPositive, half, name, position, list, big]

  it('are read as 32-bit integers by default, with 0 as false', async () => {
    const { output } = await run(
      `print(Citizen.InvokeNative(0x3000, 5), Citizen.InvokeNative(0x3000, 0), Citizen.InvokeNative(0x3000, -1))
print(Citizen.InvokeNative(0x3001, 5, Citizen.ReturnResultAnyway()), Citizen.InvokeNative(0x3001, -5, Citizen.ReturnResultAnyway()))`,
      all,
    )
    expect(output).toBe('5\tfalse\t-1\n1\tfalse\n')
  })

  it('are read the way the script asks', async () => {
    const { output } = await run(
      `local half = Citizen.InvokeNative(0x3002, 3.0, Citizen.ResultAsFloat())
print(half, math.type(half), Citizen.InvokeNative(0x3002, 4.0, Citizen.ResultAsFloat()))
print(Citizen.InvokeNative(0x3000, -1, Citizen.ResultAsInteger()), Citizen.InvokeNative(0x3000, -1, Citizen.ResultAsLong()))
print(Citizen.InvokeNative(0x3006, Citizen.ResultAsLong()), Citizen.InvokeNative(0x3006, Citizen.ResultAsInteger()))
print(Citizen.InvokeNative(0x3004, Citizen.ResultAsVector()))
print(table.concat(Citizen.InvokeNative(0x3005, Citizen.ResultAsObject2(msgpack.unpack)), ','))`,
      all,
    )
    expect(output).toBe(
      '1.5\tfloat\t2.0\n-1\t4294967295\n4294967297\t1\nvec3(1.000000, 2.000000, 3.000000)\n1,2,3\n',
    )
  })

  it('read strings as C strings unless they are binary', async () => {
    const { output } = await run(
      `for i = 0, 3 do
    local s = Citizen.InvokeNative(0x3003, i, Citizen.ResultAsString())
    print(s and #s, s)
end`,
      all,
    )
    expect(output).toBe('nil\tnil\n4\tname\n4\twith\n3\ta\0b\n')
  })

  it('are checked against the result type of the native', async () => {
    const { output } = await run(
      `print(pcall(Citizen.InvokeNative, 0x3000, 1, Citizen.ResultAsString()))
print(pcall(Citizen.InvokeNative, 0x3000, 1, Citizen.ResultAsVector()))
print(pcall(Citizen.InvokeNative, 0x3000, 1, Citizen.ResultAsObject2(msgpack.unpack)))
print(Citizen.InvokeNative(0x3003, 1), Citizen.InvokeNative(0x3003, 0))
print(Citizen.InvokeNative(0x3004))`,
      all,
    )
    expect(output).toBe(
      [
        'false\tnative 0000000000003000: result type is not a string',
        'false\tnative 0000000000003000: result type is not a vector',
        'false\tnative 0000000000003000: result type is not an object',
        '2146290430\tfalse',
        '2146290430',
        '',
      ].join('\n'),
    )
  })

  it('include out-pointers, after the primary result only when asked for', async () => {
    const out = defineNative(
      {
        name: 'GET_OUT',
        hash: 0x3100n,
        result: 'BOOL',
        params: ['int* count', 'float* scale', 'Vector3* where', 'BOOL* ok'],
      },
      (_ctx, count, scale, where, ok) => {
        count.set(count.get() + 7)
        scale.set(1.5)
        where.set(new LuaVector('vector3', 1, 2, 3))
        ok.set(true)
        return true
      },
    )
    const { output } = await run(
      `local _i, _f, _v = Citizen.PointerValueInt(), Citizen.PointerValueFloat(), Citizen.PointerValueVector()
print(Citizen.InvokeNative(0x3100, _i, _f, _v, _i))
print(Citizen.InvokeNative(0x3100, _i, _f, _v, _i, Citizen.ReturnResultAnyway()))
print(Citizen.InvokeNative(0x3100, Citizen.PointerValueIntInitialized(5), _f, _v, _i))
print(Citizen.InvokeNative(0x3100, Citizen.PointerValueFloatInitialized(5), _f, _v, _i))
print(Citizen.InvokeNative(0x3100, 0, 0, 0, 0, Citizen.ReturnResultAnyway()))`,
      [out],
    )
    expect(output).toBe(
      [
        '7\t1.5\tvec3(1.000000, 2.000000, 3.000000)\t1',
        '1\t7\t1.5\tvec3(1.000000, 2.000000, 3.000000)\t1',
        '12\t1.5\tvec3(1.000000, 2.000000, 3.000000)\t1',
        // FiveM ignores the initial value of float pointers: 0 + 7, read back as a float.
        '9.8090892502737e-45\t1.5\tvec3(1.000000, 2.000000, 3.000000)\t1',
        '1',
        '',
      ].join('\n'),
    )
  })

  it('reject buffers too small for what natives write', async () => {
    const out = defineNative(
      { name: 'GET_WHERE', hash: 0x3101n, result: 'void', params: ['Vector3* where'] },
      (_ctx, where) => where.set(new LuaVector('vector3', 1, 2, 3)),
    )
    const { output } = await run(
      `print(pcall(Citizen.InvokeNative, 0x3101, Citizen.PointerValueInt()))`,
      [out],
    )
    expect(output).toBe('false\tnative 0000000000003101: arg[0]: buffer too small (8 < 24)\n')
  })

  it('of void natives are false', async () => {
    const nothing = defineNative(
      { name: 'DO_NOTHING', hash: 0x3200n, result: 'void', params: [] },
      () => {},
    )
    const { output } = await run(`print(Citizen.InvokeNative(0x3200))`, [nothing])
    expect(output).toBe('false\n')
  })

  it('that natives set though they declare none are poisoned, unless zero', async () => {
    // Like TRIGGER_EVENT_INTERNAL, which is void but sets a BOOL.
    const voidButTrue = defineNative(
      { name: 'VOID_BUT_TRUE', hash: 0x3201n, result: 'void', sets: 'BOOL', params: ['BOOL b'] },
      (_ctx, b) => b,
    )
    const { output } = await run(
      `print(Citizen.InvokeNative(0x3201, true), Citizen.InvokeNative(0x3201, false))
print(pcall(Citizen.InvokeNative, 0x3201, true, Citizen.ResultAsString()))`,
      [voidButTrue],
    )
    expect(output).toBe(
      '2146290430\tfalse\nfalse\tnative 0000000000003201: result type is not a string\n',
    )
  })
})

describe('natives that fail', () => {
  it('raise an error naming their hash', async () => {
    const failing = defineNative(
      { name: 'FAIL', hash: 0xd24d37cc275948ccn, result: 'void', params: [] },
      () => {
        throw new NativeError('Argument at index 0 was null.')
      },
    )
    const { output, log } = await run(`print(pcall(Citizen.InvokeNative, 0xD24D37CC275948CC))`, [
      failing,
    ])
    expect(output).toBe('false\tnative d24d37cc275948cc: Argument at index 0 was null.\n')
    expect(log).toEqual([
      '[citizen-scripting-core] script error in native d24d37cc275948cc: Argument at index 0 was null.\n',
    ])
  })

  it('raise it from the function the script called, as FiveM does', async () => {
    const failing = defineNative(
      { name: 'FAIL', hash: 0x2000n, result: 'void', params: [] },
      () => {
        throw new NativeError('failed')
      },
    )
    for (const client of [false, true]) {
      const { output } = await run(
        `local invoke = Citizen.GetNative and Citizen.GetNative(0x2000) or Citizen.InvokeNative
local function fails() return invoke(0x2000) end
local function misuses() return invoke(0x2000, print) end
for _, fn in ipairs({ fails, misuses }) do
    xpcall(fn, function(err)
        local raiser, caller = debug.getinfo(2, 'S'), debug.getinfo(3, 'Sl')
        print(err, raiser.what, caller.short_src, caller.currentline)
    end)
end`,
        [failing],
        client,
      )
      expect(output).toBe(
        'native 0000000000002000: failed\tC\t@test/client.lua\t2\n' +
          'native 0000000000002000: invalid lua type: function\tC\t@test/client.lua\t3\n',
      )
    }
  })
})

describe('unknown natives', () => {
  it('do nothing and return zero values', async () => {
    const { output } = await run(
      `print(Citizen.InvokeNative(0x1234), Citizen.InvokeNative(0x1234, Citizen.ResultAsFloat()))
print(Citizen.InvokeNative(0x1234, Citizen.ResultAsString()), Citizen.InvokeNative(0x1234, Citizen.ResultAsVector()))
print(Citizen.InvokeNative(0x1234, Citizen.PointerValueIntInitialized(3), Citizen.PointerValueFloat()))
print(pcall(Citizen.InvokeNative, 0x1234, Citizen.ResultAsObject2(msgpack.unpack)))`,
    )
    expect(output).toBe(
      [
        'false\t0.0',
        'nil\tvec3(0.000000, 0.000000, 0.000000)',
        '3\t0.0',
        'false\tnative 0000000000001234: undocumented natives cannot return an object',
        '',
      ].join('\n'),
    )
  })
})

describe('Citizen markers', () => {
  it('are light userdata, equal to themselves', async () => {
    const { output } = await run(
      `print(type(Citizen.ResultAsInteger()), Citizen.ResultAsInteger() == Citizen.ResultAsInteger())
print(Citizen.PointerValueIntInitialized(1) == Citizen.PointerValueIntInitialized(1))
print(select('#', Citizen.ResultAsObject()))
print(pcall(function() return Citizen.PointerValueIntInitialized(1.5) end))
print(pcall(function() return Citizen.PointerValueFloatInitialized('x') end))
print(type(Citizen.PointerValueIntInitialized(nil)), type(Citizen.PointerValueIntInitialized(Citizen.ReturnResultAnyway())))`,
    )
    expect(output).toBe(
      [
        'userdata\ttrue',
        'false',
        '0',
        "false\t@test/client.lua:4: bad argument #1 to 'PointerValueIntInitialized' (number has no integer representation)",
        "false\t@test/client.lua:5: bad argument #1 to 'PointerValueFloatInitialized' (number expected, got string)",
        'userdata\tuserdata',
        '',
      ].join('\n'),
    )
  })
})

describe('Citizen.GetNative', () => {
  it('exists on clients only', async () => {
    expect((await run(`print(Citizen.GetNative, Citizen.InvokeNative2)`)).output).toBe('nil\tnil\n')
  })

  it('returns a function that invokes the native', async () => {
    const value = defineNative(
      { name: 'GET_VALUE', hash: 0x3000n, result: 'int', params: ['int value'] },
      (_ctx, v) => v * 2,
    )
    const { output } = await run(
      `local double = Citizen.GetNative(0x3000)
print(double(21), Citizen.InvokeNative2(double, 4))`,
      [value],
      true,
    )
    expect(output).toBe('42\t8\n')
  })

  it('hashes names itself for GET_HASH_KEY, as FiveM does', async () => {
    const { output } = await run(
      `local hash = Citizen.GetNative(0xD24D37CC275948CC)
print(hash('adder'), hash('ADDER'), hash(nil), hash(5), hash('é') == joaat('é'))`,
      [],
      true,
    )
    expect(output).toBe('-1216765807\t-1216765807\t0\t0\ttrue\n')
  })
})
