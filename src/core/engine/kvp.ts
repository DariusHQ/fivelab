/**
 * Keys and values, as FiveM keeps the KVP of resources in a LevelDB
 * database on clients and a RocksDB one on servers. Keys are bytes, which
 * FiveLab keeps as binary strings, one character per byte, so that they
 * order as the databases order them: by their bytes.
 */
export class KvpStore {
  readonly #values = new Map<string, Uint8Array>()

  get(key: string): Uint8Array | undefined {
    return this.#values.get(key)
  }

  set(key: string, value: Uint8Array): void {
    this.#values.set(key, value)
  }

  delete(key: string): void {
    this.#values.delete(key)
  }

  /** The keys that start with `prefix`, in order, as they are now. */
  keysWith(prefix: string): string[] {
    return [...this.#values.keys()].filter((key) => key.startsWith(prefix)).sort()
  }
}

/** A value that the KVP natives store, as msgpack-c reads its type. */
export type KvpValue =
  | { readonly type: 'int'; readonly value: number }
  | { readonly type: 'float'; readonly value: number }
  | { readonly type: 'string'; readonly bytes: Uint8Array }

/** A string of bytes, as msgpack-c packs a C string. */
export function packString(bytes: Uint8Array): Uint8Array {
  const { length } = bytes
  const header =
    length < 0x20
      ? [0xa0 | length]
      : length < 0x100
        ? [0xd9, length]
        : length < 0x10000
          ? [0xda, length >> 8, length & 0xff]
          : [0xdb, length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]
  const packed = new Uint8Array(header.length + length)
  packed.set(header)
  packed.set(bytes, header.length)
  return packed
}

/** An int, as msgpack-c packs one: in the smallest format, unsigned unless negative. */
export function packInt(value: number): Uint8Array {
  if (value >= -0x20 && value < 0x80) return Uint8Array.of(value & 0xff)
  const [type, size] =
    value < 0
      ? value >= -0x80
        ? [0xd0, 1]
        : value >= -0x8000
          ? [0xd1, 2]
          : [0xd2, 4]
      : value < 0x100
        ? [0xcc, 1]
        : value < 0x10000
          ? [0xcd, 2]
          : [0xce, 4]
  const packed = new Uint8Array(1 + size)
  packed[0] = type
  for (let i = 0; i < size; i++) packed[size - i] = (value >> (8 * i)) & 0xff
  return packed
}

/** A float, as msgpack-c packs one: in 32 bits. */
export function packFloat(value: number): Uint8Array {
  const packed = new Uint8Array(5)
  packed[0] = 0xca
  new DataView(packed.buffer).setFloat32(1, value)
  return packed
}

/** A value that packString, packInt or packFloat packed. */
export function unpackValue(bytes: Uint8Array): KvpValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = bytes[0]!
  const int = (value: number): KvpValue => ({ type: 'int', value })
  const string = (start: number, length: number): KvpValue => ({
    type: 'string',
    bytes: bytes.subarray(start, start + length),
  })
  if (first < 0x80) return int(first)
  if (first >= 0xe0) return int(first - 0x100)
  if (first >> 5 === 0x5) return string(1, first & 0x1f)
  switch (first) {
    case 0xcc:
      return int(view.getUint8(1))
    case 0xcd:
      return int(view.getUint16(1))
    case 0xce:
      return int(view.getUint32(1))
    case 0xd0:
      return int(view.getInt8(1))
    case 0xd1:
      return int(view.getInt16(1))
    case 0xd2:
      return int(view.getInt32(1))
    case 0xca:
      return { type: 'float', value: view.getFloat32(1) }
    case 0xd9:
      return string(2, view.getUint8(1))
    case 0xda:
      return string(3, view.getUint16(1))
    case 0xdb:
      return string(5, view.getUint32(1))
  }
  throw new Error(`The KVP natives store no value that starts with ${first}`)
}
