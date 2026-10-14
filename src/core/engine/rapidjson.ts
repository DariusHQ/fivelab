import type { MsgpackObject } from './msgpack.ts'

/** What reads no JSON value, as RapidJSON's reader stops with an error. */
class ParseError extends Error {}

/** Bytes of JSON text that RapidJSON tells apart. */
const QUOTE = 0x22
const BACKSLASH = 0x5c
const MINUS = 0x2d
const ZERO = 0x30
const NINE = 0x39

/** What the escapes of strings stand for, but \u. */
const ESCAPES = new Map([
  [0x22, 0x22],
  [0x2f, 0x2f],
  [0x5c, 0x5c],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
])

/** The powers of 10 that RapidJSON scales numbers by, which C++ rounds as it reads them. */
const POWERS = Array.from({ length: 309 }, (_, n) => Number(`1e${n}`))

const encoder = new TextEncoder()

/**
 * The msgpack value of JSON, as FiveM converts what RapidJSON's reader,
 * at the version FiveM has, reads with its default flags: or undefined
 * where the reader fails. Any value may stand alone, and a NUL ends the
 * text. Strings keep their bytes, which no encoding needs to make sense
 * of, and unpaired low surrogates. Objects become maps, as FiveM makes a
 * std::map of their members: ordered by the bytes of their names, which
 * end at a NUL, with the first member of each. Numbers with no fraction or
 * exponent that fit 64 bits are integers, and the others doubles, which
 * RapidJSON scales by powers of 10 without rounding them correctly.
 */
export function msgpackOfJson(json: Uint8Array): MsgpackObject | undefined {
  const reader = new Reader(json)
  try {
    reader.skipWhitespace()
    const value = reader.value()
    reader.skipWhitespace()
    return reader.peek() === 0 ? value : undefined
  } catch (error) {
    if (error instanceof ParseError) return undefined
    throw error
  }
}

class Reader {
  readonly #bytes: Uint8Array
  #at = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  /** The next byte, or 0 at the end, as RapidJSON's memory streams give it. */
  peek(): number {
    return this.#bytes[this.#at] ?? 0
  }

  #take(): number {
    const byte = this.peek()
    this.#at++
    return byte
  }

  #consume(byte: number): boolean {
    if (this.peek() !== byte) return false
    this.#at++
    return true
  }

  #isDigit(): boolean {
    const byte = this.peek()
    return byte >= ZERO && byte <= NINE
  }

  skipWhitespace(): void {
    for (
      let byte = this.peek();
      byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
    ) {
      this.#at++
      byte = this.peek()
    }
  }

  value(): MsgpackObject {
    switch (this.peek()) {
      case 0x6e:
        this.#literal('null')
        return { type: 'nil' }
      case 0x74:
        this.#literal('true')
        return { type: 'boolean', value: true }
      case 0x66:
        this.#literal('false')
        return { type: 'boolean', value: false }
      case QUOTE:
        return { type: 'str', bytes: this.#string() }
      case 0x7b:
        return this.#object()
      case 0x5b:
        return this.#array()
      default:
        return this.#number()
    }
  }

  #literal(word: string): void {
    for (const byte of encoder.encode(word)) {
      if (!this.#consume(byte)) throw new ParseError()
    }
  }

  #object(): MsgpackObject {
    this.#take()
    this.skipWhitespace()
    const members = new Map<string, readonly [Uint8Array, MsgpackObject]>()
    if (this.#consume(0x7d)) return { type: 'map', entries: [] }
    for (;;) {
      if (this.peek() !== QUOTE) throw new ParseError()
      const bytes = this.#string()
      this.skipWhitespace()
      if (!this.#consume(0x3a)) throw new ParseError()
      this.skipWhitespace()
      const value = this.value()
      this.skipWhitespace()
      // FiveM reads the name as a C string, and keeps the first member of each.
      const end = bytes.indexOf(0)
      const name = end === -1 ? bytes : bytes.subarray(0, end)
      const key = Array.from(name, (byte) => String.fromCharCode(byte)).join('')
      if (!members.has(key)) members.set(key, [name, value])
      if (this.#consume(0x2c)) {
        this.skipWhitespace()
      } else if (this.#consume(0x7d)) {
        // A std::map orders strings by their bytes, as their Latin-1 characters order them.
        const entries = [...members].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        return {
          type: 'map',
          entries: entries.map(
            ([, [name, value]]) => [{ type: 'str', bytes: name }, value] as const,
          ),
        }
      } else {
        throw new ParseError()
      }
    }
  }

  #array(): MsgpackObject {
    this.#take()
    this.skipWhitespace()
    const items: MsgpackObject[] = []
    if (this.#consume(0x5d)) return { type: 'array', items }
    for (;;) {
      items.push(this.value())
      this.skipWhitespace()
      if (this.#consume(0x2c)) this.skipWhitespace()
      else if (this.#consume(0x5d)) return { type: 'array', items }
      else throw new ParseError()
    }
  }

  /** The bytes of the string that starts here, as UTF-8, which RapidJSON copies as they are. */
  #string(): Uint8Array {
    this.#take()
    const bytes: number[] = []
    for (;;) {
      const byte = this.#take()
      if (byte === BACKSLASH) {
        const escape = this.#take()
        const escaped = ESCAPES.get(escape)
        if (escaped !== undefined) {
          bytes.push(escaped)
        } else if (escape === 0x75) {
          let codePoint = this.#hex4()
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (!this.#consume(BACKSLASH) || !this.#consume(0x75)) throw new ParseError()
            const low = this.#hex4()
            if (low < 0xdc00 || low > 0xdfff) throw new ParseError()
            codePoint = ((codePoint - 0xd800) << 10) + (low - 0xdc00) + 0x10000
          }
          bytes.push(...utf8(codePoint))
        } else {
          throw new ParseError()
        }
      } else if (byte === QUOTE) {
        return new Uint8Array(bytes)
      } else if (byte < 0x20) {
        throw new ParseError()
      } else {
        bytes.push(byte)
      }
    }
  }

  #hex4(): number {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const digit = Number.parseInt(String.fromCharCode(this.#take()), 16)
      if (Number.isNaN(digit)) throw new ParseError()
      value = value * 16 + digit
    }
    return value
  }

  /** A number, as RapidJSON's ParseNumber reads it on 64-bit machines, without full precision. */
  #number(): MsgpackObject {
    const minus = this.#consume(MINUS)
    // The significand, while it fits the integers that RapidJSON keeps it in.
    let integer = 0n
    let double: number | undefined
    // The digits of the significand after its first, as RapidJSON counts them while they count.
    let digits = 0
    const limit = minus ? 2n ** 63n : 2n ** 64n - 1n
    if (this.#consume(ZERO)) {
      // A number that starts with 0 has no more digits before its fraction.
    } else if (this.#isDigit()) {
      integer = BigInt(this.#take() - ZERO)
      while (this.#isDigit()) {
        const next = integer * 10n + BigInt(this.peek() - ZERO)
        if (next > limit) {
          double = Number(integer)
          break
        }
        integer = next
        this.#at++
        digits++
      }
    } else {
      throw new ParseError()
    }
    if (double !== undefined) {
      // RapidJSON adds the digits that follow too, which a double that large has no room for.
      while (this.#isDigit()) {
        double *= 10
        this.#at++
      }
    }
    let fraction = 0
    if (this.#consume(0x2e)) {
      if (!this.#isDigit()) throw new ParseError()
      if (double === undefined) {
        while (this.#isDigit() && integer <= 2n ** 53n - 1n) {
          integer = integer * 10n + BigInt(this.#take() - ZERO)
          fraction--
          if (integer !== 0n) digits++
        }
        double = Number(integer)
      }
      while (this.#isDigit()) {
        if (digits < 17) {
          double = double * 10 + (this.#take() - ZERO)
          fraction--
          digits++
        } else {
          this.#at++
        }
      }
    }
    let exponent = 0
    if (this.#consume(0x65) || this.#consume(0x45)) {
      double ??= Number(integer)
      const negative = !this.#consume(0x2b) && this.#consume(MINUS)
      if (!this.#isDigit()) throw new ParseError()
      exponent = this.#take() - ZERO
      // RapidJSON fails for numbers that it would scale by more than 10 to the power of 308.
      while (this.#isDigit()) {
        exponent = exponent * 10 + (this.#take() - ZERO)
        if (!negative && exponent > 308 - fraction) throw new ParseError()
      }
      if (negative) exponent = -exponent
    }
    if (double === undefined) {
      const value = minus ? -integer : integer
      return { type: value < 0n ? 'negative' : 'positive', value }
    }
    const scaled = scale(double, exponent + fraction)
    if (scaled > Number.MAX_VALUE) throw new ParseError()
    return { type: 'float64', value: minus ? -scaled : scaled }
  }
}

/** A double scaled by 10 to the power of `exponent`, as RapidJSON's StrtodNormalPrecision does. */
function scale(value: number, exponent: number): number {
  if (exponent < -308) return fastPath(fastPath(value, -308), exponent + 308)
  return fastPath(value, exponent)
}

function fastPath(value: number, exponent: number): number {
  if (exponent < -308) return 0
  return exponent >= 0 ? value * POWERS[exponent]! : value / POWERS[-exponent]!
}

/** The UTF-8 bytes of a code point, which may be a surrogate, as RapidJSON's UTF8::Encode writes them. */
function utf8(codePoint: number): number[] {
  if (codePoint < 0x80) return [codePoint]
  if (codePoint < 0x800) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)]
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)]
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ]
}
