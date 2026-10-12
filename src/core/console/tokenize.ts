import { jsonLength } from './json.ts'

const SPACE = 0x20
const QUOTE = 0x22
const HASH = 0x23
const STAR = 0x2a
const SLASH = 0x2f
const BRACKET = 0x5b
const BACKSLASH = 0x5c
const BRACE = 0x7b

/**
 * Splits a command line into its arguments, as FiveM's console::Tokenize
 * does. Arguments are separated by whitespace: any character up to a space,
 * control characters included. An argument is
 *
 * - a JSON array or object, whole;
 * - or quoted: up to the next quote or the end of the line, where \" is a
 *   quote, and an argument even when empty;
 * - or the characters up to whitespace or a quote.
 *
 * #, // and /* at the start of the line end it, and so do # and // where
 * another argument could start. There, /* starts a comment whose end FiveM
 * looks for from its own *, so it skips only itself and the character
 * after it.
 */
export function tokenize(line: string): string[] {
  const points = Array.from(line, (char) => char.codePointAt(0)!)
  const args: string[] = []
  const length = points.length
  // FiveM reads past the end of the line, where it finds the terminator.
  const at = (i: number) => (i < length ? points[i]! : 0)
  let i = 0
  for (;;) {
    // Skip whitespace and comments up to the next argument.
    for (;;) {
      while (i < length && points[i]! <= SPACE) i++
      if (i >= length) return args
      const comment = points[i] === HASH || (points[i] === SLASH && at(i + 1) === SLASH)
      if (i === 0) {
        if (comment || (points[i] === SLASH && at(i + 1) === STAR)) return args
        break
      }
      if (comment) return args
      if (points[i] !== SLASH || at(i + 1) !== STAR) break
      // FiveM looks for the end of the comment from its *, where it stops at
      // once, and goes on two characters later.
      i += 3
    }
    if (points[i] === BRACKET || points[i] === BRACE) {
      const json = jsonLength(points, i)
      if (json !== undefined) {
        args.push(text(points, i, i + json))
        i += json
        continue
      }
    }
    if (points[i] === QUOTE) {
      const quoted: number[] = []
      let escaped = false
      for (i++; i < length; i++) {
        if (points[i] === QUOTE && !escaped) break
        if (points[i] === BACKSLASH && at(i + 1) === QUOTE) {
          escaped = true
        } else {
          quoted.push(points[i]!)
          escaped = false
        }
      }
      i++
      args.push(text(quoted, 0, quoted.length))
      if (i >= length) return args
      continue
    }
    // What starts here is neither whitespace nor a quote, so it is not empty.
    const start = i
    while (i < length && points[i]! > SPACE && points[i] !== QUOTE) i++
    args.push(text(points, start, i))
    if (i >= length) return args
  }
}

/**
 * A command line of bytes as FiveM on Windows decodes it from UTF-8, with
 * MSVC's codecvt_utf8, or undefined if it cannot, when FiveM's tokenizer
 * gives no arguments. It takes overlong sequences, and those of surrogates
 * and of five and six bytes, for code points up to U+10FFFF, but no
 * sequence that the bytes end within.
 *
 * FiveM encodes the surrogates it decodes back to UTF-8 one by one, while
 * strings keep them as UTF-16 does: a high and a low one in a row are the
 * code point they spell.
 */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  const points: number[] = []
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i]!
    if (lead >= 0x80 && lead < 0xc0) return undefined
    const extra =
      lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : lead < 0xf8 ? 3 : lead < 0xfc ? 4 : 5
    if (bytes.length - i < extra + 1) return undefined
    let point = lead & [0x7f, 0x1f, 0x0f, 0x07, 0x03, 0x03][extra]!
    for (let k = 1; k <= extra; k++) {
      const next = bytes[i + k]!
      if (next < 0x80 || next >= 0xc0) return undefined
      point = point * 64 + (next & 0x3f)
    }
    if (point > 0x10ffff) return undefined
    points.push(point)
    i += extra + 1
  }
  return text(points, 0, points.length)
}

/** The string of code points `start` to `end`. */
function text(points: readonly number[], start: number, end: number): string {
  let result = ''
  for (let i = start; i < end; i += 4096) {
    result += String.fromCodePoint(...points.slice(i, Math.min(i + 4096, end)))
  }
  return result
}
