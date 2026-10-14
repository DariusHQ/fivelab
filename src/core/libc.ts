/**
 * C's atoi: the integer at the start of a string, or 0. Integers that do not
 * fit in 32 bits give the closest that does, as on Windows.
 */
export function atoi(text: string): number {
  const digits = /^[\t-\r ]*[+-]?\d+/.exec(text)
  if (digits === null) return 0
  return Math.min(Math.max(Number.parseInt(digits[0], 10), -(2 ** 31)), 2 ** 31 - 1)
}

/**
 * C's strtoull in base 16: the hexadecimal number at the start of `text`,
 * after an optional sign and 0x, or 0. Numbers that do not fit in 64 bits
 * give the largest that does, and a minus sign negates the result.
 */
export function strtoull(text: string): bigint {
  const parts = /^[\t-\r ]*([+-]?)(?:0[xX](?=[\da-fA-F]))?([\da-fA-F]*)/.exec(text)!
  if (parts[2] === '') return 0n
  const value = BigInt(`0x${parts[2]}`)
  if (value > MAX_UINT64) return MAX_UINT64
  return parts[1] === '-' ? BigInt.asUintN(64, -value) : value
}

/**
 * C++'s std::stoull in base 10: the number at the start of `text`, after
 * whitespace and an optional sign, or undefined, where std::stoull throws,
 * if there is none or it does not fit in 64 bits. A minus sign negates the
 * result.
 */
export function stoull(text: string): bigint | undefined {
  const parts = /^[\t-\r ]*([+-]?)(\d+)/.exec(text)
  if (parts === null) return undefined
  const value = BigInt(parts[2]!)
  if (value > MAX_UINT64) return undefined
  return parts[1] === '-' ? BigInt.asUintN(64, -value) : value
}

const MAX_UINT64 = 2n ** 64n - 1n

/**
 * C++'s std::stoi: the int at the start of `text`, after whitespace and an
 * optional sign, or undefined, where std::stoi throws, if there is none or
 * it does not fit in 32 bits.
 */
export function stoi(text: string): number | undefined {
  const parts = /^[\t-\r ]*([+-]?\d+)/.exec(text)
  if (parts === null) return undefined
  const value = BigInt(parts[1]!)
  return value < -(2n ** 31n) || value >= 2n ** 31n ? undefined : Number(value)
}

/** What MSVC's std::stoi throws with for text that stoi reads no int from. */
export function stoiError(text: string): string {
  return /^[\t-\r ]*[+-]?\d/.test(text) ? 'stoi argument out of range' : 'invalid stoi argument'
}

/**
 * C++'s std::stof as MSVC's runtime reads floats: the float at the start of
 * `text`, after whitespace and an optional sign, or undefined, where
 * std::stof throws, if there is none or it is out of range, too large for a
 * float or so small that it rounds to 0. Floats are decimal, with their
 * first 768 significant digits rounded correctly, or hexadecimal, with 0x
 * before them, or inf, infinity or nan in any case. The NaNs it reads are
 * all the same.
 */
export function stof(text: string): number | undefined {
  const start = /^[\t-\r ]*([+-]?)/.exec(text)!
  const sign = start[1] === '-' ? -1 : 1
  const rest = text.slice(start[0].length)
  if (/^inf/i.test(rest)) return sign * Infinity
  if (/^nan/i.test(rest)) return NaN
  const hex = /^0[xX]/.test(rest)
  const digits = hex ? '[\\dA-Fa-f]' : '\\d'
  const mantissa = new RegExp(`^(${digits}*)(?:\\.(${digits}*))?`).exec(rest.slice(hex ? 2 : 0))!
  const [whole = '', fraction = ''] = [mantissa[1], mantissa[2]]
  // MSVC reads 0x without digits as 0, followed by an x.
  if (whole === '' && fraction === '') return hex ? sign * 0 : undefined
  const after = rest.slice((hex ? 2 : 0) + mantissa[0].length)
  const exponent = new RegExp(`^${hex ? '[pP]' : '[eE]'}([+-]?)(\\d+)`).exec(after)
  // Leading zeros are not significant, and MSVC keeps 768 digits that are.
  const leading = /^0*/.exec(whole)![0].length
  let shift = whole.length - leading
  let significant = whole.slice(leading) + fraction
  if (shift === 0) {
    const zeros = /^0*/.exec(fraction)![0].length
    shift = -zeros
    significant = fraction.slice(zeros)
  }
  significant = significant.slice(0, 768)
  if (significant === '') return sign * 0
  // MSVC gives up on exponents beyond 5200, even where the shift brings
  // them back.
  let power = 0
  if (exponent !== null) {
    const value = Number(exponent[2])
    if (value > 5200) return undefined
    power = exponent[1] === '-' ? -value : value
  }
  power += hex ? shift * 4 : shift
  // Beyond 5200 after the shift, floats are out of range anyway.
  if (power > 5200 || power < -5200) return undefined
  const value = BigInt(hex ? `0x${significant}` : significant)
  const tens = power - significant.length
  const exact = hex
    ? roundFloat(value, 1n, power - significant.length * 4)
    : roundFloat(value * 10n ** BigInt(Math.max(tens, 0)), 10n ** BigInt(Math.max(-tens, 0)), 0)
  return exact === undefined ? undefined : sign * exact
}

/**
 * The float nearest to `numerator / denominator * 2 ** twos`, ties to even,
 * or undefined if it is too large for a float or rounds to 0.
 */
function roundFloat(numerator: bigint, denominator: bigint, twos: number): number | undefined {
  /** The value over 2 ** exponent: its whole part, and what remains of the denominator. */
  const divide = (exponent: number) => {
    const shift = twos - exponent
    const n = shift >= 0 ? numerator << BigInt(shift) : numerator
    const d = shift >= 0 ? denominator : denominator << BigInt(-shift)
    return { whole: n / d, rest: n % d, of: d }
  }
  // The worth of the mantissa's last bit, for a mantissa of 24 bits, or for
  // a denormal's, whose last bit is worth 2 ** -149.
  let exponent = bitLength(numerator) - bitLength(denominator) + twos - 24
  if (divide(exponent).whole >= 2n ** 24n) exponent++
  exponent = Math.max(exponent, -149)
  const { whole, rest, of } = divide(exponent)
  const twice = 2n * rest
  let mantissa = twice > of || (twice === of && (whole & 1n) === 1n) ? whole + 1n : whole
  if (mantissa === 2n ** 24n) {
    mantissa = 2n ** 23n
    exponent++
  }
  if (mantissa === 0n || exponent > 104) return undefined
  return Number(mantissa) * 2 ** exponent
}

function bitLength(value: bigint): number {
  return value.toString(2).length
}

/**
 * The key of a string as MSVC's _stricmp sees it: the string up to its first
 * NUL, where C strings end, with its ASCII letters lowercased. compareUtf8
 * orders keys as _stricmp orders their strings.
 */
export function stricmpKey(text: string): string {
  return lowerAscii(text.split('\0', 1)[0]!)
}

/** A string lowercased as C's tolower lowercases characters, which is only ASCII letters. */
export function lowerAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

/** Orders strings as C++ orders their UTF-8 bytes, which is by code point. */
export function compareUtf8(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const x = a.codePointAt(i)!
    const y = b.codePointAt(i)!
    if (x !== y) return x - y
    if (x > 0xffff) i++
  }
  return a.length - b.length
}
