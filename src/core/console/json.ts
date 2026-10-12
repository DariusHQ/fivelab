/**
 * JSON in command lines, which FiveM's console keeps in one argument. FiveM
 * finds it with nlohmann's JSON library, 3.11.2: a JSON value is there when
 * nlohmann's parser accepts one, without comments, whatever follows it.
 */

// The tokens of nlohmann's lexer, as far as its parser tells them apart.
const BEGIN_ARRAY = 0
const END_ARRAY = 1
const BEGIN_OBJECT = 2
const END_OBJECT = 3
const NAME_SEPARATOR = 4
const VALUE_SEPARATOR = 5
const STRING = 6
/** A number, true, false or null. */
const LITERAL = 7
/** The end of the input, a NUL, or what no token is. */
const INVALID = 8

/**
 * The length of the JSON array or object at `start` of `units`, or undefined
 * if nlohmann's parser accepts none there. The units are bytes of UTF-8 or,
 * as FiveM's tokenizer gives them, code points, which the parser takes for
 * bytes: in strings, it takes code points over U+007F only where they spell
 * UTF-8, so none over U+00FF.
 */
export function jsonLength(units: ArrayLike<number>, start: number): number | undefined {
  if (units[start] !== 0x5b && units[start] !== 0x7b) return undefined
  const scanner = new Scanner(units, start)
  // Whether each array or object the value is in is an array, innermost last.
  const open: boolean[] = []
  let token = scanner.scan()
  for (;;) {
    // A value starts with `token`.
    if (token === BEGIN_ARRAY || token === BEGIN_OBJECT) {
      const array = token === BEGIN_ARRAY
      token = scanner.scan()
      if (token !== (array ? END_ARRAY : END_OBJECT)) {
        if (!array && (token !== STRING || scanner.scan() !== NAME_SEPARATOR)) return undefined
        open.push(array)
        if (!array) token = scanner.scan()
        continue
      }
    } else if (token !== STRING && token !== LITERAL) {
      return undefined
    }
    // The value ended, and so may the arrays and objects around it.
    for (;;) {
      const array = open.at(-1)
      if (array === undefined) return scanner.position - start
      token = scanner.scan()
      if (token === VALUE_SEPARATOR) {
        token = scanner.scan()
        if (!array) {
          if (token !== STRING || scanner.scan() !== NAME_SEPARATOR) return undefined
          token = scanner.scan()
        }
        break
      }
      if (token !== (array ? END_ARRAY : END_OBJECT)) return undefined
      open.pop()
    }
  }
}

/** The bytes that may follow a lead byte in a string, as ranges of each. */
function continuations(lead: number): readonly number[] | undefined {
  if (lead >= 0xc2 && lead <= 0xdf) return [0x80, 0xbf]
  if (lead === 0xe0) return [0xa0, 0xbf, 0x80, 0xbf]
  if (lead === 0xed) return [0x80, 0x9f, 0x80, 0xbf]
  if (lead >= 0xe1 && lead <= 0xef) return [0x80, 0xbf, 0x80, 0xbf]
  if (lead === 0xf0) return [0x90, 0xbf, 0x80, 0xbf, 0x80, 0xbf]
  if (lead >= 0xf1 && lead <= 0xf3) return [0x80, 0xbf, 0x80, 0xbf, 0x80, 0xbf]
  if (lead === 0xf4) return [0x80, 0x8f, 0x80, 0xbf, 0x80, 0xbf]
  return undefined
}

function isDigit(unit: number): boolean {
  return unit >= 0x30 && unit <= 0x39
}

/** The value of a hex digit, or -1. */
function hexDigit(unit: number): number {
  if (isDigit(unit)) return unit - 0x30
  if (unit >= 0x41 && unit <= 0x46) return unit - 0x37
  if (unit >= 0x61 && unit <= 0x66) return unit - 0x57
  return -1
}

/** nlohmann's lexer, which reads one token at a time. */
class Scanner {
  readonly #units: ArrayLike<number>
  /** Where the next token, or the whitespace before it, starts. */
  position: number

  constructor(units: ArrayLike<number>, start: number) {
    this.#units = units
    this.position = start
  }

  /** The unit at the position, or -1 at the end of the input. */
  #peek(): number {
    return this.position < this.#units.length ? this.#units[this.position]! : -1
  }

  /** Reads the unit at the position, or -1 at the end of the input. */
  #next(): number {
    const unit = this.#peek()
    if (unit !== -1) this.position++
    return unit
  }

  scan(): number {
    let unit = this.#next()
    while (unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d) unit = this.#next()
    switch (unit) {
      case 0x5b:
        return BEGIN_ARRAY
      case 0x5d:
        return END_ARRAY
      case 0x7b:
        return BEGIN_OBJECT
      case 0x7d:
        return END_OBJECT
      case 0x3a:
        return NAME_SEPARATOR
      case 0x2c:
        return VALUE_SEPARATOR
      case 0x74:
        return this.#literal('rue')
      case 0x66:
        return this.#literal('alse')
      case 0x6e:
        return this.#literal('ull')
      case 0x22:
        return this.#string()
      default:
        return unit === 0x2d || isDigit(unit) ? this.#number(unit) : INVALID
    }
  }

  /** The rest of true, false or null. */
  #literal(rest: string): number {
    for (let i = 0; i < rest.length; i++) {
      if (this.#next() !== rest.charCodeAt(i)) return INVALID
    }
    return LITERAL
  }

  /** The rest of a string, after its opening quote. */
  #string(): number {
    for (;;) {
      const unit = this.#next()
      if (unit === 0x22) return STRING
      if (unit === 0x5c) {
        if (!this.#escape()) return INVALID
      } else if (unit > 0x7f) {
        const ranges = continuations(unit)
        if (ranges === undefined) return INVALID
        for (let i = 0; i < ranges.length; i += 2) {
          const next = this.#next()
          if (next < ranges[i]! || next > ranges[i + 1]!) return INVALID
        }
      } else if (unit < 0x20) {
        // Control characters, and the end of the input, which is -1.
        return INVALID
      }
    }
  }

  /** Whether an escape, after its backslash, is one of JSON's. */
  #escape(): boolean {
    const unit = this.#next()
    // ", \, /, b, f, n, r and t.
    if ([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(unit)) return true
    if (unit !== 0x75) return false
    const first = this.#hex()
    if (first >= 0xdc00 && first <= 0xdfff) return false
    if (first < 0xd800 || first > 0xdbff) return first !== -1
    // A high surrogate needs a low one.
    if (this.#next() !== 0x5c || this.#next() !== 0x75) return false
    const second = this.#hex()
    return second >= 0xdc00 && second <= 0xdfff
  }

  /** The code unit that four hex digits spell, or -1. */
  #hex(): number {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const digit = hexDigit(this.#next())
      if (digit === -1) return -1
      value = value * 16 + digit
    }
    return value
  }

  /**
   * The rest of a number, after its first unit, which ends before the first
   * unit that cannot continue it. nlohmann's parser takes no numbers that
   * overflow doubles.
   */
  #number(first: number): number {
    const start = this.position - 1
    if (first === 0x2d) {
      if (!isDigit(this.#peek())) return INVALID
      first = this.#next()
    }
    if (first !== 0x30) this.#digits()
    if (this.#peek() === 0x2e) {
      this.position++
      if (!isDigit(this.#peek())) return INVALID
      this.#digits()
    }
    if (this.#peek() === 0x65 || this.#peek() === 0x45) {
      this.position++
      if (this.#peek() === 0x2b || this.#peek() === 0x2d) this.position++
      if (!isDigit(this.#peek())) return INVALID
      this.#digits()
    }
    let text = ''
    for (let i = start; i < this.position; i++) text += String.fromCharCode(this.#units[i]!)
    return Number.isFinite(Number(text)) ? LITERAL : INVALID
  }

  #digits(): void {
    while (isDigit(this.#peek())) this.position++
  }
}
