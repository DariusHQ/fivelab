const encoder = new TextEncoder()

/**
 * FiveM's HashString, the joaat hash behind GetHashKey and the hashes of CFX
 * natives: over the bytes up to the first NUL, with ASCII letters lowercased
 * and each byte taken as a signed char. Returns an unsigned 32-bit hash.
 */
export function hashString(text: string | Uint8Array): number {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text
  let hash = 0
  for (const byte of bytes) {
    if (byte === 0) break
    const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte
    hash = (hash + (lower < 0x80 ? lower : lower - 0x100)) >>> 0
    hash = (hash + (hash << 10)) >>> 0
    hash = (hash ^ (hash >>> 6)) >>> 0
  }
  hash = (hash + (hash << 3)) >>> 0
  hash = (hash ^ (hash >>> 11)) >>> 0
  return (hash + (hash << 15)) >>> 0
}

/**
 * The global a native is called by in Lua, from its declared name as FiveM's
 * code generator derives it: GET_ENTITY_COORDS becomes GetEntityCoords and
 * _0x1234ABCD becomes N_0x1234abcd.
 */
export function luaName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll('0x', 'n_0x')
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    .replace(/([a-zA-Z])([\s\S]+)/, (_, first: string, rest: string) => first.toUpperCase() + rest)
}

const HASH_NAME = /^N_0x([0-9a-f]{16})$/

/** The hash in the name of an unnamed native, such as N_0xd01005d2ba2eb778, if it is one. */
export function hashInName(name: string): bigint | undefined {
  const match = HASH_NAME.exec(name)
  return match === null ? undefined : BigInt(`0x${match[1]}`)
}

/**
 * The declared name a Lua name comes from, for names luaName produces from
 * names in capitals: GetEntityCoords becomes GET_ENTITY_COORDS.
 */
export function declaredName(lua: string): string {
  let name = ''
  for (let i = 0; i < lua.length; i++) {
    const char = lua[i]!
    if (char >= 'A' && char <= 'Z') name += i > 0 ? `_${char}` : char
    else name += char.toUpperCase()
  }
  return name
}
