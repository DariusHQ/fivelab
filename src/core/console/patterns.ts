import { lowerAscii } from '../libc.ts'

/**
 * Whether names match a pattern, as FiveM's MakeRegex makes them match for
 * its channel filters and its convar change listeners: whole names, as
 * written but for the case of their ASCII letters, with * for any text and
 * spaces or + between names.
 */
export function namePattern(pattern: string): (name: string) => boolean {
  const source = pattern
    .replace(/[.^$|()[\]{}?\\]/g, '\\$&')
    .replaceAll(' ', '|')
    .replaceAll('+', '|')
    .replaceAll('*', '.*')
  // FiveRunner lowercases both, where FiveM ignores case as C's tolower does.
  const regex = new RegExp(`^(?:${lowerAscii(source)})$`)
  return (name) => regex.test(lowerAscii(name))
}
