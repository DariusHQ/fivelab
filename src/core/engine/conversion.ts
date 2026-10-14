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
