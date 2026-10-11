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

const MAX_UINT64 = 2n ** 64n - 1n
