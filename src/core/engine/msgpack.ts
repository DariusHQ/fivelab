/** A value FiveLab gives scripts as msgpack, such as the arguments of an event. */
export type PackedValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
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
  } else if (n >= 0) {
    if (n < 0x80) writer.byte(n)
    else if (n < 0x100) writer.fixed(0xcc, 1, (view, at) => view.setUint8(at, n))
    else if (n < 0x10000) writer.fixed(0xcd, 2, (view, at) => view.setUint16(at, n))
    else if (n < 0x100000000) writer.fixed(0xce, 4, (view, at) => view.setUint32(at, n))
    else writer.fixed(0xcf, 8, (view, at) => view.setBigUint64(at, BigInt(n)))
  } else {
    if (n >= -0x20) writer.byte(n & 0xff)
    else if (n >= -0x80) writer.fixed(0xd0, 1, (view, at) => view.setInt8(at, n))
    else if (n >= -0x8000) writer.fixed(0xd1, 2, (view, at) => view.setInt16(at, n))
    else if (n >= -0x80000000) writer.fixed(0xd2, 4, (view, at) => view.setInt32(at, n))
    else writer.fixed(0xd3, 8, (view, at) => view.setBigInt64(at, BigInt(n)))
  }
}
