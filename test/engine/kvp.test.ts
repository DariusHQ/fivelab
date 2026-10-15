import { describe, expect, it } from 'vitest'

import { KvpStore, packFloat, packInt, packString, unpackValue } from '../../src/core/engine/kvp.ts'
import { FIND_HANDLES } from '../../src/core/engine/natives/kvp.ts'
import { createProcess, runCommand, startResource } from './helpers.ts'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/** The errors of a native that fails in a resource, as pcall gives them and the console says them. */
function nativeErrors(resource: string, hash: string, message: string): string[] {
  const error = `native 00000000${hash}: ${message}`
  return [
    `[citizen-scripting-core] script error in ${error}`,
    `[script:${resource}] false\t${error}`,
  ]
}

describe('The values of the KVP', () => {
  it('pack ints as msgpack-c does, in the smallest format, unsigned unless negative', () => {
    const packed = [0, 127, 128, 255, 256, 65535, 65536, 2 ** 31 - 1].map((n) => hex(packInt(n)))
    expect(packed).toEqual([
      '00',
      '7f',
      'cc80',
      'ccff',
      'cd0100',
      'cdffff',
      'ce00010000',
      'ce7fffffff',
    ])
    const negative = [-1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31)].map((n) =>
      hex(packInt(n)),
    )
    expect(negative).toEqual([
      'ff',
      'e0',
      'd0df',
      'd080',
      'd1ff7f',
      'd18000',
      'd2ffff7fff',
      'd280000000',
    ])
  })

  it('pack floats in 32 bits and strings by their lengths, as msgpack-c does', () => {
    expect(hex(packFloat(0.1))).toBe('ca3dcccccd')
    const header = (length: number) => hex(packString(new Uint8Array(length))).slice(0, 10)
    expect([0, 31, 32, 255, 256, 65535, 65536].map(header)).toEqual([
      'a0',
      'bf' + '00'.repeat(31).slice(0, 8),
      'd920' + '000000',
      'd9ff' + '000000',
      'da0100' + '0000',
      'daffff' + '0000',
      'db00010000',
    ])
    expect(header(2 ** 24)).toBe('db01000000')
  })

  it('unpack what they pack', () => {
    const ints = [0, 127, 128, 255, 256, 65535, 65536, 2 ** 31 - 1, -1, -32, -33, -128, -129]
    for (const n of [...ints, -32768, -32769, -(2 ** 31)]) {
      expect(unpackValue(packInt(n))).toEqual({ type: 'int', value: n })
    }
    expect(unpackValue(packFloat(0.5))).toEqual({ type: 'float', value: 0.5 })
    for (const length of [0, 31, 32, 255, 256, 65535, 65536]) {
      const bytes = Uint8Array.from({ length }, (_, i) => i & 0xff)
      expect(unpackValue(packString(bytes))).toEqual({ type: 'string', bytes })
    }
  })
})

describe('KvpStore', () => {
  it('finds keys by prefix in the order of their bytes', () => {
    const store = new KvpStore()
    for (const key of ['b', 'a\xff', 'a1', 'a', 'a\x80', 'c']) store.set(key, new Uint8Array())
    store.delete('c')
    expect(store.keysWith('a')).toEqual(['a', 'a1', 'a\x80', 'a\xff'])
    expect(store.get('b')).toEqual(new Uint8Array())
    expect(store.get('c')).toBeUndefined()
  })
})

describe('KVP natives', () => {
  it('keep strings, ints and floats for each resource', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `SetResourceKvp('name', 'value')
SetResourceKvpInt('count', 42)
SetResourceKvpFloat('ratio', 0.1)
SetResourceKvpNoSync('fast', 'f')
SetResourceKvpIntNoSync('fastInt', -7)
SetResourceKvpFloatNoSync('fastFloat', 1.5)
print(GetResourceKvpString('name'), GetResourceKvpInt('count'), GetResourceKvpFloat('ratio'))
print(GetResourceKvpFloat('count'), GetResourceKvpString('fast'), GetResourceKvpInt('fastInt'), GetResourceKvpFloat('fastFloat'))`,
      }),
    ).toEqual(['[script:a] value\t42\t0.10000000149012', '[script:a] 42.0\tf\t-7\t1.5'])
    expect(
      startResource(proc, 'b', {
        'main.lua': `print(GetResourceKvpString('name'), GetResourceKvpInt('count'), GetResourceKvpFloat('ratio'))`,
      }),
    ).toEqual(['[script:b] nil\t0\t0.0'])
    expect(hex(proc.manager.kvp.get('res:a:name')!)).toBe(hex(packString(Buffer.from('value'))))
    expect(hex(proc.manager.kvp.get('res:a:count')!)).toBe('2a')
    expect(hex(proc.manager.kvp.get('res:a:ratio')!)).toBe('ca3dcccccd')
  })

  it('read ints as floats, as msgpack-c converts them', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `SetResourceKvpInt('big', 16777217)
print(GetResourceKvpFloat('big'))`,
      }),
    ).toEqual(['[script:a] 16777216.0'])
  })

  it('delete values', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `SetResourceKvp('one', '1')
SetResourceKvp('two', '2')
DeleteResourceKvp('one')
DeleteResourceKvpNoSync('two')
DeleteResourceKvp('none')
print(GetResourceKvpString('one'), GetResourceKvpString('two'))`,
      }),
    ).toEqual(['[script:a] nil\tnil'])
  })

  it('keep the bytes of keys and strings up to a NUL', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `SetResourceKvp('k\\0ey', 'va\\0lue')
SetResourceKvp('\\xff', '\\xfe\\x80')
print(GetResourceKvpString('k'), GetResourceKvpString('\\xff') == '\\xfe\\x80')`,
      }),
    ).toEqual(['[script:a] va\ttrue'])
    expect([...proc.manager.kvp.keysWith('res:a:')]).toEqual(['res:a:k', 'res:a:\xff'])
  })

  it('fail to read values of other types, as msgpack-c does', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `SetResourceKvp('text', 'x')
SetResourceKvpInt('int', 1)
SetResourceKvpFloat('float', 1.5)
print(pcall(GetResourceKvpInt, 'text'))
print(pcall(GetResourceKvpInt, 'float'))
print(pcall(GetResourceKvpString, 'int'))
print(pcall(GetResourceKvpString, 'float'))
print(pcall(GetResourceKvpFloat, 'text'))`,
      }),
    ).toEqual([
      ...nativeErrors('a', '557b586a', 'bad cast'),
      ...nativeErrors('a', '557b586a', 'bad cast'),
      ...nativeErrors('a', '5240da5a', 'bad cast'),
      ...nativeErrors('a', '5240da5a', 'bad cast'),
      ...nativeErrors('a', '35bdceea', 'bad cast'),
    ])
  })

  it('check their arguments, the value of strings before the key', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(pcall(SetResourceKvp, nil, nil))
print(pcall(SetResourceKvp, nil, 'v'))
print(pcall(SetResourceKvpInt, nil, 1))
print(pcall(GetResourceKvpString, nil))
print(pcall(DeleteResourceKvp, nil))
print(pcall(StartFindKvp, nil))`,
      }),
    ).toEqual([
      ...nativeErrors('a', '21c7a35b', 'Argument at index 1 was null.'),
      ...nativeErrors('a', '21c7a35b', 'Argument at index 0 was null.'),
      ...nativeErrors('a', '06a2b1e8', 'Argument at index 0 was null.'),
      ...nativeErrors('a', '5240da5a', 'Argument at index 0 was null.'),
      ...nativeErrors('a', '7389b5df', 'Argument at index 0 was null.'),
      ...nativeErrors('a', 'dd379006', 'Argument at index 0 was null.'),
    ])
  })

  it('find keys by prefix, in the order of their bytes, as the database was when the search started', async () => {
    const proc = await createProcess()
    startResource(proc, 'ab', { 'main.lua': `SetResourceKvp('x', 'other resource')` })
    expect(
      startResource(proc, 'a', {
        'main.lua': `for _, key in ipairs({ 'b', 'a2', 'a1', 'a10', 'z' }) do SetResourceKvp(key, key) end
local handle = StartFindKvp('a')
SetResourceKvp('a3', 'added')
DeleteResourceKvp('a2')
local keys = {}
for _ = 1, 5 do keys[#keys + 1] = tostring(FindKvp(handle)) end
EndFindKvp(handle)
print(handle, table.concat(keys, ' '))
local all = StartFindKvp('')
local key = FindKvp(all)
local found = {}
while key do found[#found + 1] = key key = FindKvp(all) end
EndFindKvp(all)
print(all, table.concat(found, ' '))`,
      }),
    ).toEqual(['[script:a] 0\ta1 a10 a2 nil nil', '[script:a] 0\ta1 a10 a3 b z'])
  })

  it(`keep ${FIND_HANDLES} searches for all resources`, async () => {
    const proc = await createProcess()
    startResource(proc, 'a', {
      'main.lua': `for _ = 1, ${FIND_HANDLES} do StartFindKvp('') end
print(StartFindKvp(''))`,
    })
    expect(
      startResource(proc, 'b', {
        'main.lua': `print(StartFindKvp(''))
EndFindKvp(5)
EndFindKvp(-1)
EndFindKvp(${FIND_HANDLES})
print(StartFindKvp(''), StartFindKvp(''))`,
      }),
    ).toEqual(['[script:b] -1', '[script:b] 5\t-1'])
    expect(proc.take()).toEqual([])
  })

  it('say when FindKvp is given no search', async () => {
    const proc = await createProcess()
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(FindKvp(-1), FindKvp(${FIND_HANDLES}), FindKvp(3))`,
      }),
    ).toEqual(['[script:a] nil\tnil\tnil'])
    expect(proc.diagnostics).toEqual([
      'a: FindKvp was given -1, which is no handle: FiveM sets no result, so the script reads the handle as the string, which can crash. FiveRunner returns nil.',
      `a: FindKvp was given ${FIND_HANDLES}, which is no handle: FiveM sets no result, so the script reads the handle as the string, which can crash. FiveRunner returns nil.`,
      'a: FindKvp was given handle 3, which no search has: FiveM reads its search all the same, and crashes. FiveRunner returns nil.',
    ])
  })

  it('name keys without the prefix of the resource that calls FindKvp, on servers', async () => {
    const proc = await createProcess()
    startResource(proc, 'abc', {
      'main.lua': `AddEventHandler('find', function(handle)
  print(pcall(FindKvp, handle))
  print(pcall(FindKvp, handle))
end)`,
    })
    expect(
      startResource(proc, 'a', {
        'main.lua': `SetResourceKvp('ke', '1')
SetResourceKvp('key', '2')
TriggerEvent('find', StartFindKvp('ke'))
SetResourceKvp('k', '3')
local handle = StartFindKvp('k')
TriggerEvent('find', handle)
print(FindKvp(handle))`,
      }),
    ).toEqual([
      // res:a:ke is as long as res:abc:, and res:a:k shorter.
      '[script:abc] true\t',
      '[script:abc] true\ty',
      ...nativeErrors('abc', 'bd7bebc5', 'invalid string position'),
      ...nativeErrors('abc', 'bd7bebc5', 'invalid string position'),
      '[script:a] k',
    ])
  })

  it('open the database of servers when scripts first use it, which adds sv_kvsName', async () => {
    const opened = async (main: string) => {
      const proc = await createProcess()
      startResource(proc, 'a', { 'main.lua': main })
      return proc.manager.console.variables.find('sv_kvsName')?.value
    }
    const uses = [
      `SetResourceKvp('k', 'v')`,
      `SetResourceKvpInt('k', 1)`,
      `SetResourceKvpFloat('k', 1.5)`,
      `DeleteResourceKvp('k')`,
      `GetResourceKvpString('k')`,
      `GetResourceKvpInt('k')`,
      `GetResourceKvpFloat('k')`,
      `StartFindKvp('k')`,
      `FindKvp(0)`,
      `pcall(SetResourceKvpInt, nil, 1)`,
    ]
    for (const main of uses) expect(await opened(main)).toBe('default')
    // FiveM checks the value of strings before it opens the database.
    for (const main of [`pcall(SetResourceKvp, 'k', nil)`, `EndFindKvp(0)`]) {
      expect(await opened(main)).toBeUndefined()
    }
    const named = await createProcess()
    runCommand(named.manager, 'set sv_kvsName mine', 'system.console')
    startResource(named, 'a', { 'main.lua': `FlushResourceKvp()` })
    expect(named.manager.console.variables.find('sv_kvsName')?.value).toBe('mine')
    const client = await createProcess({ side: 'client' })
    startResource(client, 'a', { 'main.lua': `GetResourceKvpInt('k')` })
    expect(client.manager.console.variables.find('sv_kvsName')).toBeUndefined()
  })

  it('read the KVP of other resources on clients', async () => {
    const proc = await createProcess({ side: 'client' })
    startResource(proc, 'long', {
      'main.lua': `SetResourceKvp('name', 'value')
SetResourceKvpInt('count', 3)
SetResourceKvpFloat('ratio', 2.5)`,
    })
    expect(
      startResource(proc, 'b', {
        'main.lua': `SetResourceKvp('own', 'mine')
print(GetExternalKvpString('long', 'name'), GetExternalKvpInt('long', 'count'), GetExternalKvpFloat('long', 'ratio'))
print(GetExternalKvpString('', 'own'), GetExternalKvpString('long', 'nope'), GetExternalKvpInt('c', 'count'))
local handle = StartFindExternalKvp('long', '')
print(handle, FindKvp(handle), FindKvp(handle), FindKvp(handle), FindKvp(handle))
print(pcall(GetExternalKvpString, nil, nil))
print(pcall(GetExternalKvpString, 'a', nil))
print(pcall(StartFindExternalKvp, 'a', nil))
print(FlushResourceKvp)`,
      }),
    ).toEqual([
      '[script:b] value\t3\t2.5',
      '[script:b] mine\tnil\t0',
      '[script:b] 0\tcount\tname\tratio\tnil',
      ...nativeErrors('b', '9080363a', 'Argument at index 0 was null.'),
      ...nativeErrors('b', '9080363a', 'Argument at index 1 was null.'),
      ...nativeErrors('b', '8f2eecc3', 'Argument at index 1 was null.'),
      '[script:b] nil',
    ])
  })

  it('give clients the prefix of the resource searched, and no external KVP on servers', async () => {
    const client = await createProcess({ side: 'client' })
    startResource(client, 'abc', {
      'main.lua': `AddEventHandler('find', function(handle) print(FindKvp(handle)) end)`,
    })
    expect(
      startResource(client, 'a', {
        'main.lua': `SetResourceKvp('k', '1')
TriggerEvent('find', StartFindKvp(''))`,
      }),
    ).toEqual(['[script:abc] k'])
    const server = await createProcess()
    expect(
      startResource(server, 'a', {
        'main.lua': `print(GetExternalKvpString, StartFindExternalKvp)`,
      }),
    ).toEqual(['[script:a] nil\tnil'])
  })

  it('keep the KVP in the store the process is given', async () => {
    const kvp = new KvpStore()
    kvp.set('res:a:kept', packInt(5))
    const proc = await createProcess({ kvp })
    expect(startResource(proc, 'a', { 'main.lua': `print(GetResourceKvpInt('kept'))` })).toEqual([
      '[script:a] 5',
    ])
    expect(proc.manager.kvp).toBe(kvp)
  })
})
