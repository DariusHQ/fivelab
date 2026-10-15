import { VariableFlags } from '../../console/index.ts'
import { defineNative, NativeError, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { packFloat, packInt, packString, unpackValue, type KvpValue } from '../kvp.ts'
import { checkArgument } from './events.ts'

/** How many searches of the KVP FiveM keeps at once, for all resources. */
export const FIND_HANDLES = 64

const encoder = new TextEncoder()
const NO_BYTES: Uint8Array = new Uint8Array()

/** Bytes as a binary string, one character per byte. */
function binary(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return text
}

/** A binary string as its bytes. */
function bytesOf(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}

/** Bytes as FiveM reads a C string of them: up to a NUL. */
function cString(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0)
  return end === -1 ? bytes : bytes.subarray(0, end)
}

/** What msgpack-c throws for a value of another type, as MSVC names it. */
function badCast(): NativeError {
  return new NativeError('bad cast')
}

/** A search of the KVP: the keys it finds, which FiveM's iterators take as the database was. */
interface Search {
  readonly keys: readonly string[]
  next: number
  /**
   * How long the prefix of the keys of the resource is, on clients, which
   * keep it for the resource searched. Servers take it from the resource
   * that calls FindKvp.
   */
  readonly prefixLength: number | undefined
}

/** Natives of the KVP of resources, in the database of the process. */
export function kvpNatives(side: Side): NativeDefinition<NativeContext>[] {
  const searches: (Search | undefined)[] = Array.from({ length: FIND_HANDLES }, () => undefined)
  /**
   * A key of the database, as FiveM formats them: res:<resource>:<key>, of
   * the resource that calls the native, or of `resource` unless empty.
   */
  const formatKey = (ctx: NativeContext, key: Uint8Array, resource: Uint8Array = NO_BYTES) => {
    const name = resource.length === 0 ? encoder.encode(ctx.resource.name) : resource
    return `res:${binary(name)}:${binary(key)}`
  }
  /** Opens the database, as FiveM's servers do when scripts first use it, which adds sv_kvsName. */
  const openDatabase = (ctx: NativeContext) => {
    const { variables } = ctx.manager.console
    if (side === 'server' && variables.find('sv_kvsName') === undefined) {
      variables.define('sv_kvsName', VariableFlags.none, 'string', 'default')
    }
  }
  const read = (ctx: NativeContext, key: string): KvpValue | undefined => {
    const value = ctx.manager.kvp.get(key)
    return value === undefined ? undefined : unpackValue(value)
  }
  const set = (ctx: NativeContext, key: Uint8Array | null, value: Uint8Array) => {
    openDatabase(ctx)
    ctx.manager.kvp.set(formatKey(ctx, cString(checkArgument(key, 0))), value)
  }
  const remove = (ctx: NativeContext, key: Uint8Array | null) => {
    openDatabase(ctx)
    ctx.manager.kvp.delete(formatKey(ctx, cString(checkArgument(key, 0))))
  }
  const startFind = (ctx: NativeContext, key: string, prefixLength: number | undefined) => {
    const handle = searches.indexOf(undefined)
    if (handle === -1) return -1
    searches[handle] = { keys: ctx.manager.kvp.keysWith(key), next: 0, prefixLength }
    return handle
  }
  const asString = (value: KvpValue | undefined) => {
    if (value === undefined) return null
    if (value.type !== 'string') throw badCast()
    return value.bytes
  }
  const asInt = (value: KvpValue | undefined) => {
    if (value === undefined) return 0
    if (value.type !== 'int') throw badCast()
    return value.value
  }
  const asFloat = (value: KvpValue | undefined) => {
    if (value === undefined) return 0
    if (value.type === 'string') throw badCast()
    return value.value
  }
  // FiveM packs the value before it reads the key.
  const natives = [
    ...['SET_RESOURCE_KVP', 'SET_RESOURCE_KVP_NO_SYNC'].map((name) =>
      defineNative(
        { name, result: 'void', params: ['bytes key', 'bytes value'] },
        (ctx: NativeContext, key, value) => {
          const packed = packString(cString(checkArgument(value, 1)))
          set(ctx, key, packed)
        },
      ),
    ),
    ...['SET_RESOURCE_KVP_INT', 'SET_RESOURCE_KVP_INT_NO_SYNC'].map((name) =>
      defineNative(
        { name, result: 'void', params: ['bytes key', 'int value'] },
        (ctx: NativeContext, key, value) => set(ctx, key, packInt(value)),
      ),
    ),
    ...['SET_RESOURCE_KVP_FLOAT', 'SET_RESOURCE_KVP_FLOAT_NO_SYNC'].map((name) =>
      defineNative(
        { name, result: 'void', params: ['bytes key', 'float value'] },
        (ctx: NativeContext, key, value) => set(ctx, key, packFloat(value)),
      ),
    ),
    ...['DELETE_RESOURCE_KVP', 'DELETE_RESOURCE_KVP_NO_SYNC'].map((name) =>
      defineNative({ name, result: 'void', params: ['bytes key'] }, remove),
    ),
    defineNative(
      { name: 'GET_RESOURCE_KVP_STRING', result: 'char*', params: ['bytes key'] },
      (ctx: NativeContext, key) => {
        openDatabase(ctx)
        return asString(read(ctx, formatKey(ctx, cString(checkArgument(key, 0)))))
      },
    ),
    defineNative(
      { name: 'GET_RESOURCE_KVP_INT', result: 'int', params: ['bytes key'] },
      (ctx: NativeContext, key) => {
        openDatabase(ctx)
        return asInt(read(ctx, formatKey(ctx, cString(checkArgument(key, 0)))))
      },
    ),
    defineNative(
      { name: 'GET_RESOURCE_KVP_FLOAT', result: 'float', params: ['bytes key'] },
      (ctx: NativeContext, key) => {
        openDatabase(ctx)
        return asFloat(read(ctx, formatKey(ctx, cString(checkArgument(key, 0)))))
      },
    ),
    defineNative(
      { name: 'START_FIND_KVP', result: 'int', params: ['bytes prefix'] },
      (ctx: NativeContext, prefix) => {
        openDatabase(ctx)
        const key = formatKey(ctx, cString(checkArgument(prefix, 0)))
        const length = side === 'client' ? formatKey(ctx, NO_BYTES).length : undefined
        return startFind(ctx, key, length)
      },
    ),
    defineNative(
      { name: 'FIND_KVP', result: 'char*', params: ['int handle'] },
      (ctx: NativeContext, handle) => {
        openDatabase(ctx)
        if (handle < 0 || handle >= FIND_HANDLES) {
          ctx.diagnose(
            `FindKvp was given ${handle}, which is no handle: FiveM sets no result, so the script reads the handle as the string, which can crash. FiveRunner returns nil.`,
          )
          return null
        }
        const search = searches[handle]
        if (search === undefined) {
          ctx.diagnose(
            `FindKvp was given handle ${handle}, which no search has: FiveM reads its search all the same, and crashes. FiveRunner returns nil.`,
          )
          return null
        }
        const key = search.keys[search.next]
        if (key === undefined) return null
        const prefixLength = search.prefixLength ?? formatKey(ctx, NO_BYTES).length
        // The prefix of the resource that calls FindKvp on servers may be longer than the key.
        if (prefixLength > key.length) throw new NativeError('invalid string position')
        search.next++
        return bytesOf(key.slice(prefixLength))
      },
    ),
    defineNative(
      { name: 'END_FIND_KVP', result: 'void', params: ['int handle'] },
      (ctx: NativeContext, handle) => {
        if (handle >= 0 && handle < FIND_HANDLES) searches[handle] = undefined
      },
    ),
  ]
  if (side === 'server') {
    return [
      ...natives,
      defineNative({ name: 'FLUSH_RESOURCE_KVP', result: 'void', params: [] }, openDatabase),
    ]
  }
  // MSVC evaluates the arguments of FiveM's call to FormatKey last first, so
  // it checks the resource before the key.
  const external = (ctx: NativeContext, resource: Uint8Array | null, key: Uint8Array | null) => {
    const name = cString(checkArgument(resource, 0))
    return read(ctx, formatKey(ctx, cString(checkArgument(key, 1)), name))
  }
  return [
    ...natives,
    defineNative(
      {
        name: 'GET_EXTERNAL_KVP_STRING',
        result: 'char*',
        params: ['bytes resource', 'bytes key'],
      },
      (ctx: NativeContext, resource, key) => asString(external(ctx, resource, key)),
    ),
    defineNative(
      { name: 'GET_EXTERNAL_KVP_INT', result: 'int', params: ['bytes resource', 'bytes key'] },
      (ctx: NativeContext, resource, key) => asInt(external(ctx, resource, key)),
    ),
    defineNative(
      { name: 'GET_EXTERNAL_KVP_FLOAT', result: 'float', params: ['bytes resource', 'bytes key'] },
      (ctx: NativeContext, resource, key) => asFloat(external(ctx, resource, key)),
    ),
    defineNative(
      {
        name: 'START_FIND_EXTERNAL_KVP',
        result: 'int',
        params: ['bytes resourceName', 'bytes prefix'],
      },
      (ctx: NativeContext, resourceName, prefix) => {
        const name = cString(checkArgument(resourceName, 0))
        const key = formatKey(ctx, cString(checkArgument(prefix, 1)), name)
        return startFind(ctx, key, formatKey(ctx, NO_BYTES, name).length)
      },
    ),
  ]
}
