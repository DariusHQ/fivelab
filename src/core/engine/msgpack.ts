import { compareUtf8 } from '../libc.ts'

/**
 * A msgpack extension: a type and its bytes, as FiveM packs references to
 * functions, in extension 10, and to those of its own code, in 11.
 */
export class Extension {
  readonly type: number
  readonly data: Uint8Array

  constructor(type: number, data: Uint8Array) {
    this.type = type
    this.data = data
  }
}

/** A value FiveLab gives scripts as msgpack, such as the arguments of an event. */
export type PackedValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Extension
  | readonly PackedValue[]
  | { readonly [key: string]: PackedValue }

/** The first bytes of the formats of a kind of value that starts with its size. */
interface SizedFormats {
  /** The format that holds sizes below `limit` in its first byte. */
  readonly fix?: { readonly byte: number; readonly limit: number }
  readonly size8?: number
  readonly size16: number
  readonly size32: number
}

const STRING: SizedFormats = {
  fix: { byte: 0xa0, limit: 32 },
  size8: 0xd9,
  size16: 0xda,
  size32: 0xdb,
}
const BINARY: SizedFormats = { size8: 0xc4, size16: 0xc5, size32: 0xc6 }
const ARRAY: SizedFormats = { fix: { byte: 0x90, limit: 16 }, size16: 0xdc, size32: 0xdd }
const MAP: SizedFormats = { fix: { byte: 0x80, limit: 16 }, size16: 0xde, size32: 0xdf }
const EXTENSION: SizedFormats = { size8: 0xc7, size16: 0xc8, size32: 0xc9 }

/** The first bytes of the fixext formats, by the sizes of their data, which msgpack-c packs those sizes in. */
const FIXEXT = new Map([
  [1, 0xd4],
  [2, 0xd5],
  [4, 0xd6],
  [8, 0xd7],
  [16, 0xd8],
])

const utf8 = new TextEncoder()

/** Bytes that grow as values are written to them. */
class Writer {
  #bytes = new Uint8Array(64)
  #view = new DataView(this.#bytes.buffer)
  #length = 0

  get bytes(): Uint8Array {
    return this.#bytes.slice(0, this.#length)
  }

  byte(value: number): void {
    const offset = this.#take(1)
    this.#bytes[offset] = value
  }

  /** Writes a format's first byte, then `size` bytes that `set` writes. */
  fixed(first: number, size: number, set: (view: DataView, offset: number) => void): void {
    const offset = this.#take(1 + size)
    this.#bytes[offset] = first
    set(this.#view, offset + 1)
  }

  /** Writes the first bytes of a value of `size` items or bytes, in the smallest of its formats. */
  sized(formats: SizedFormats, size: number): void {
    const { fix, size8, size16, size32 } = formats
    if (fix !== undefined && size < fix.limit) {
      this.byte(fix.byte | size)
    } else if (size8 !== undefined && size < 0x100) {
      this.fixed(size8, 1, (view, at) => view.setUint8(at, size))
    } else if (size < 0x10000) {
      this.fixed(size16, 2, (view, at) => view.setUint16(at, size))
    } else {
      this.fixed(size32, 4, (view, at) => view.setUint32(at, size))
    }
  }

  raw(bytes: Uint8Array): void {
    const offset = this.#take(bytes.length)
    this.#bytes.set(bytes, offset)
  }

  /**
   * Makes room for `size` more bytes and returns where they start. It can
   * replace #bytes, so callers take room before they read #bytes.
   */
  #take(size: number): number {
    const offset = this.#length
    if (offset + size > this.#bytes.length) {
      const bytes = new Uint8Array(Math.max(this.#bytes.length * 2, offset + size))
      bytes.set(this.#bytes.subarray(0, offset))
      this.#bytes = bytes
      this.#view = new DataView(bytes.buffer)
    }
    this.#length = offset + size
    return offset
  }
}

/**
 * Packs a value as msgpack the way FiveM's msgpack-c packs the values it
 * gives scripts: each in the smallest of the formats that hold it. Numbers
 * that are integers pack as integers, which Lua reads as integers, and the
 * others as doubles.
 */
export function pack(value: PackedValue): Uint8Array {
  const writer = new Writer()
  write(writer, value)
  return writer.bytes
}

/** The number of items of the array that msgpack `bytes` start with, or 0 if they start with none. */
export function arrayLength(bytes: Uint8Array): number {
  const first = bytes[0] ?? 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // fixarray, array 16 and array 32.
  if (first >> 4 === 0x9) return first & 0xf
  if (first === 0xdc && bytes.length >= 3) return view.getUint16(1)
  if (first === 0xdd && bytes.length >= 5) return view.getUint32(1)
  return 0
}

function write(writer: Writer, value: PackedValue): void {
  if (value === null) {
    writer.byte(0xc0)
  } else if (typeof value === 'boolean') {
    writer.byte(value ? 0xc3 : 0xc2)
  } else if (typeof value === 'number') {
    writeNumber(writer, value)
  } else if (typeof value === 'string') {
    const bytes = utf8.encode(value)
    writer.sized(STRING, bytes.length)
    writer.raw(bytes)
  } else if (value instanceof Uint8Array) {
    writer.sized(BINARY, value.length)
    writer.raw(value)
  } else if (value instanceof Extension) {
    writeExtension(writer, value)
  } else if (isArray(value)) {
    writer.sized(ARRAY, value.length)
    for (const item of value) write(writer, item)
  } else {
    const entries = Object.entries(value)
    writer.sized(MAP, entries.length)
    for (const [key, item] of entries) {
      write(writer, key)
      write(writer, item)
    }
  }
}

function isArray(value: PackedValue): value is readonly PackedValue[] {
  return Array.isArray(value)
}

function writeNumber(writer: Writer, n: number): void {
  if (!Number.isInteger(n) || Object.is(n, -0) || n < -(2 ** 63) || n >= 2 ** 64) {
    writer.fixed(0xcb, 8, (view, at) => view.setFloat64(at, n))
  } else {
    writeInteger(writer, BigInt(n))
  }
}

/** Writes an integer in the smallest of its formats, as msgpack-c packs integers. */
function writeInteger(writer: Writer, n: bigint): void {
  const small = Number(n)
  if (n >= 0n) {
    if (n < 0x80n) writer.byte(small)
    else if (n < 0x100n) writer.fixed(0xcc, 1, (view, at) => view.setUint8(at, small))
    else if (n < 0x10000n) writer.fixed(0xcd, 2, (view, at) => view.setUint16(at, small))
    else if (n < 0x100000000n) writer.fixed(0xce, 4, (view, at) => view.setUint32(at, small))
    else writer.fixed(0xcf, 8, (view, at) => view.setBigUint64(at, n))
  } else {
    if (n >= -0x20n) writer.byte(small & 0xff)
    else if (n >= -0x80n) writer.fixed(0xd0, 1, (view, at) => view.setInt8(at, small))
    else if (n >= -0x8000n) writer.fixed(0xd1, 2, (view, at) => view.setInt16(at, small))
    else if (n >= -0x80000000n) writer.fixed(0xd2, 4, (view, at) => view.setInt32(at, small))
    else writer.fixed(0xd3, 8, (view, at) => view.setBigInt64(at, n))
  }
}

function writeExtension(writer: Writer, extension: Extension): void {
  const fix = FIXEXT.get(extension.data.length)
  if (fix === undefined) writer.sized(EXTENSION, extension.data.length)
  else writer.byte(fix)
  writer.byte(extension.type)
  writer.raw(extension.data)
}

/**
 * Packs a msgpack value as msgpack-c packs a msgpack::object: as its type,
 * in the smallest of the formats of that type.
 */
export function packObject(object: MsgpackObject): Uint8Array {
  const writer = new Writer()
  writeObject(writer, object)
  return writer.bytes
}

function writeObject(writer: Writer, object: MsgpackObject): void {
  switch (object.type) {
    case 'nil':
      writer.byte(0xc0)
      break
    case 'boolean':
      writer.byte(object.value ? 0xc3 : 0xc2)
      break
    case 'positive':
    case 'negative':
      writeInteger(writer, object.value)
      break
    case 'float32':
      writer.fixed(0xca, 4, (view, at) => view.setFloat32(at, object.value))
      break
    case 'float64':
      writer.fixed(0xcb, 8, (view, at) => view.setFloat64(at, object.value))
      break
    case 'str':
    case 'bin':
      writer.sized(object.type === 'str' ? STRING : BINARY, object.bytes.length)
      writer.raw(object.bytes)
      break
    case 'array':
      writer.sized(ARRAY, object.items.length)
      for (const item of object.items) writeObject(writer, item)
      break
    case 'map':
      writer.sized(MAP, object.entries.length)
      for (const [key, value] of object.entries) {
        writeObject(writer, key)
        writeObject(writer, value)
      }
      break
    case 'ext':
      writeExtension(writer, object.extension)
      break
  }
}

/**
 * A value that msgpack holds, as msgpack-c's msgpack::object has it: by
 * the type of its format, but for integers, which are positive when they
 * are not negative, whichever format holds them.
 */
export type MsgpackObject =
  | { readonly type: 'nil' }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'positive' | 'negative'; readonly value: bigint }
  | { readonly type: 'float32' | 'float64'; readonly value: number }
  | { readonly type: 'str' | 'bin'; readonly bytes: Uint8Array }
  | { readonly type: 'array'; readonly items: readonly MsgpackObject[] }
  | {
      readonly type: 'map'
      readonly entries: readonly (readonly [key: MsgpackObject, value: MsgpackObject])[]
    }
  | { readonly type: 'ext'; readonly extension: Extension }

/** Unpacks the msgpack value that `bytes` start with, as msgpack-c does. Throws for bytes that hold none. */
export function unpackObject(bytes: Uint8Array): MsgpackObject {
  return new Reader(bytes).object()
}

/** Reads msgpack values from bytes. */
class Reader {
  readonly #bytes: Uint8Array
  readonly #view: DataView
  #offset = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  object(): MsgpackObject {
    const first = this.#uint(1)
    if (first < 0x80) return integer(BigInt(first))
    if (first >= 0xe0) return integer(BigInt(first - 0x100))
    if (first < 0x90) return this.#map(first & 0x0f)
    if (first < 0xa0) return this.#array(first & 0x0f)
    if (first < 0xc0) return { type: 'str', bytes: this.#take(first & 0x1f) }
    const fixext = [0xd4, 0xd5, 0xd6, 0xd7, 0xd8].indexOf(first)
    if (fixext !== -1) return this.#extension(2 ** fixext)
    switch (first) {
      case 0xc0:
        return { type: 'nil' }
      case 0xc2:
      case 0xc3:
        return { type: 'boolean', value: first === 0xc3 }
      case 0xc4:
      case 0xc5:
      case 0xc6:
        return { type: 'bin', bytes: this.#take(this.#uint(2 ** (first - 0xc4))) }
      case 0xc7:
      case 0xc8:
      case 0xc9:
        return this.#extension(this.#uint(2 ** (first - 0xc7)))
      case 0xca:
        return { type: 'float32', value: this.#read(4, (view, at) => view.getFloat32(at)) }
      case 0xcb:
        return { type: 'float64', value: this.#read(8, (view, at) => view.getFloat64(at)) }
      case 0xcc:
      case 0xcd:
      case 0xce:
        return integer(BigInt(this.#uint(2 ** (first - 0xcc))))
      case 0xcf:
        return integer(this.#read(8, (view, at) => view.getBigUint64(at)))
      case 0xd0:
        return integer(BigInt(this.#read(1, (view, at) => view.getInt8(at))))
      case 0xd1:
        return integer(BigInt(this.#read(2, (view, at) => view.getInt16(at))))
      case 0xd2:
        return integer(BigInt(this.#read(4, (view, at) => view.getInt32(at))))
      case 0xd3:
        return integer(this.#read(8, (view, at) => view.getBigInt64(at)))
      case 0xd9:
      case 0xda:
      case 0xdb:
        return { type: 'str', bytes: this.#take(this.#uint(2 ** (first - 0xd9))) }
      case 0xdc:
      case 0xdd:
        return this.#array(this.#uint(first === 0xdc ? 2 : 4))
      case 0xde:
      case 0xdf:
        return this.#map(this.#uint(first === 0xde ? 2 : 4))
      default:
        throw new Error('msgpack has no format 0xc1')
    }
  }

  #array(length: number): MsgpackObject {
    const items: MsgpackObject[] = []
    for (let i = 0; i < length; i++) items.push(this.object())
    return { type: 'array', items }
  }

  #map(length: number): MsgpackObject {
    const entries: [MsgpackObject, MsgpackObject][] = []
    for (let i = 0; i < length; i++) entries.push([this.object(), this.object()])
    return { type: 'map', entries }
  }

  #extension(length: number): MsgpackObject {
    const type = this.#read(1, (view, at) => view.getInt8(at))
    return { type: 'ext', extension: new Extension(type, this.#take(length)) }
  }

  /** Reads a big-endian unsigned integer of `size` bytes, from 1 to 4. */
  #uint(size: number): number {
    return this.#read(size, (view, at) => {
      if (size === 1) return view.getUint8(at)
      return size === 2 ? view.getUint16(at) : view.getUint32(at)
    })
  }

  #read<T>(size: number, get: (view: DataView, at: number) => T): T {
    return get(this.#view, this.#advance(size))
  }

  #take(size: number): Uint8Array {
    const at = this.#advance(size)
    return this.#bytes.slice(at, at + size)
  }

  /** Moves past `size` bytes, and returns where they start. */
  #advance(size: number): number {
    const at = this.#offset
    if (at + size > this.#bytes.length) throw new Error('msgpack ends before its value does')
    this.#offset = at + size
    return at
  }
}

function integer(value: bigint): MsgpackObject {
  return { type: value < 0n ? 'negative' : 'positive', value }
}

const decoder = new TextDecoder()

/**
 * The string that a msgpack value converts to as msgpack-c converts them,
 * from str and bin, or undefined for others, which msgpack-c fails to
 * convert.
 */
export function stringOf(object: MsgpackObject): string | undefined {
  return object.type === 'str' || object.type === 'bin' ? decoder.decode(object.bytes) : undefined
}

/**
 * The JSON of a msgpack value, as FiveM's ConvertToJSON converts it and
 * RapidJSON writes it, or undefined for one that it fails to write, with
 * a number that is not finite. Maps become objects by their keys in the
 * order of their bytes: those whose first key is a string by their string
 * keys, and the others by their integer keys as strings; maps with keys of
 * other types fail to convert, which throws a TypeError. Extensions become
 * null.
 */
export function toJson(object: MsgpackObject): string | undefined {
  switch (object.type) {
    case 'nil':
    case 'ext':
      return 'null'
    case 'boolean':
      return String(object.value)
    case 'positive':
    case 'negative':
      return String(object.value)
    case 'float32':
    case 'float64':
      return jsonDouble(object.value)
    case 'str':
    case 'bin':
      return jsonString(object.bytes)
    case 'array': {
      const items = object.items.map(toJson)
      return items.includes(undefined) ? undefined : `[${items.join(',')}]`
    }
    case 'map': {
      const members = jsonMembers(object.entries)
      const written = members.map(([key, value]) => {
        const json = toJson(value)
        return json === undefined ? undefined : `${jsonString(utf8.encode(key))}:${json}`
      })
      return written.includes(undefined) ? undefined : `{${written.join(',')}}`
    }
  }
}

/**
 * The members of a map as FiveM's ConvertToJSON takes them: into a
 * std::map of strings, so ordered by their bytes, with the last of each
 * key.
 */
function jsonMembers(
  entries: readonly (readonly [MsgpackObject, MsgpackObject])[],
): [string, MsgpackObject][] {
  const first = entries[0]?.[0]
  const byString = first?.type === 'str'
  const members = new Map<string, MsgpackObject>()
  for (const [key, value] of entries) {
    const name = byString ? stringOf(key) : intKey(key)
    if (name === undefined) throw new TypeError('A msgpack map has a key of another type')
    members.set(name, value)
  }
  return [...members].sort(([a], [b]) => compareUtf8(a, b))
}

/** An integer key as msgpack-c converts it to an int, as a string, or undefined for others. */
function intKey(key: MsgpackObject): string | undefined {
  if (key.type !== 'positive' && key.type !== 'negative') return undefined
  if (key.value < -0x80000000n || key.value > 0x7fffffffn) return undefined
  return String(key.value)
}

/** A double as RapidJSON writes it: its shortest digits, with .0 for integers and e for exponents. */
function jsonDouble(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined
  const text = Object.is(value, -0) ? '-0' : String(value).replace('e+', 'e')
  return /[.e]/.test(text) ? text : `${text}.0`
}

/** A string as RapidJSON writes it, which escapes quotes, backslashes and control characters. */
function jsonString(bytes: Uint8Array): string {
  let text = '"'
  for (const char of decoder.decode(bytes)) {
    const code = char.codePointAt(0)!
    const short = JSON_ESCAPES.get(char)
    if (short !== undefined) text += short
    else if (code < 0x20) text += `\\u00${code.toString(16).toUpperCase().padStart(2, '0')}`
    else text += char
  }
  return `${text}"`
}

const JSON_ESCAPES = new Map([
  ['"', '\\"'],
  ['\\', '\\\\'],
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
])
