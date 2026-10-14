import { compareUtf8 } from '../libc.ts'
import { stringOf, type MsgpackObject } from './msgpack.ts'

/** Calls of callbacks with values that FiveM fails to convert, which FiveLab ignores. */
export class ConversionError extends Error {}

/** How FiveLab names the types of msgpack values. */
const KINDS: Readonly<Record<MsgpackObject['type'], string>> = {
  nil: 'nil',
  boolean: 'a boolean',
  positive: 'an integer',
  negative: 'an integer',
  float32: 'a float',
  float64: 'a float',
  str: 'a string',
  bin: 'a binary',
  array: 'an array',
  map: 'a map',
  ext: 'an extension',
}

/** The string an argument converts to, as msgpack-c converts str and bin, which fails for others. */
export function stringArgument(object: MsgpackObject): string {
  const text = stringOf(object)
  if (text === undefined) {
    throw new ConversionError(`${KINDS[object.type]}, which msgpack fails to convert to a string`)
  }
  return text
}

/** The bytes of the string an argument converts to; see stringArgument. */
export function bytesArgument(object: MsgpackObject): Uint8Array {
  if (object.type === 'str' || object.type === 'bin') return object.bytes
  throw new ConversionError(`${KINDS[object.type]}, which msgpack fails to convert to a string`)
}

/** The int an argument converts to, as msgpack-c converts the integers that an int holds, which fails for others. */
export function intArgument(object: MsgpackObject): number {
  if (object.type !== 'positive' && object.type !== 'negative') {
    throw new ConversionError(`${KINDS[object.type]}, which msgpack fails to convert to an int`)
  }
  if (object.value < -0x8000_0000n || object.value > 0x7fff_ffffn) {
    throw new ConversionError(
      'an integer that an int does not hold, which msgpack fails to convert',
    )
  }
  return Number(object.value)
}

/** The arguments of a call, as msgpack-c converts them to a vector, which fails for what is no array. */
export function argumentsOf(object: MsgpackObject): readonly MsgpackObject[] {
  if (object.type === 'array') return object.items
  throw new ConversionError(
    'arguments that are no array, which msgpack fails to convert to a vector',
  )
}

/**
 * The entries of a map, as msgpack-c converts one to a std::map with keys
 * of strings: the last of each key, by key in the order of their bytes.
 * It fails for what is no map, and for maps with keys of other types.
 */
export function stringMapArgument(object: MsgpackObject): [string, MsgpackObject][] {
  if (object.type !== 'map') {
    throw new ConversionError(`${KINDS[object.type]}, which msgpack fails to convert to a map`)
  }
  const entries = new Map<string, MsgpackObject>()
  for (const [key, value] of object.entries) {
    const name = stringOf(key)
    if (name === undefined) {
      throw new ConversionError(
        `a map with ${KINDS[key.type]} for a key, which msgpack fails to convert to a string`,
      )
    }
    entries.set(name, value)
  }
  return [...entries].sort(([a], [b]) => compareUtf8(a, b))
}
