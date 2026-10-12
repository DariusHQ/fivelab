import { compareUtf8 } from '../libc.ts'
import type { FileEntry, FileSystem } from './files.ts'

/**
 * Normalizes a path as FiveM does before it globs it: backslashes become
 * slashes, repeated slashes and "." parts go, ".." parts take out the part
 * before them, or stay when there is none, and so do spaces around the
 * path and a slash at its end.
 */
export function normalizePath(path: string): string {
  const trimmed = path.replace(/^[\t-\r ]+|[\t-\r ]+$/g, '').replaceAll('\\', '/')
  const drive = /^[A-Za-z]:/.exec(trimmed)?.[0] ?? ''
  const rest = trimmed.slice(drive.length)
  const root = rest.startsWith('//') ? '//' : rest.startsWith('/') ? '/' : ''
  const parts: string[] = []
  let depth = 0
  for (const part of rest.slice(root.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && depth > 0) {
      parts.pop()
      depth--
    } else if (part === '..') {
      parts.push(part)
    } else {
      parts.push(part)
      depth++
    }
  }
  return drive + root + parts.join('/')
}

/** What a glob found. */
export interface GlobResult {
  /** The files, relative to the resource, in the order of their UTF-8 bytes. */
  readonly files: string[]
  /**
   * Whether every part the value spells out exists. FiveM's server warns
   * about values that found no files only when this is false.
   */
  readonly found: boolean
}

/**
 * Expands the value of a manifest entry into the files it names, as FiveM
 * does: * and ? match within a part of a path, and ** at the start of a part
 * matches across directories. Values that start with @ name files of other
 * resources and stay as they are.
 *
 * Like FiveM, it leaves out the character before a slash that follows a *,
 * so dir*\/main.lua finds only dir/main.lua, and *\/main.lua finds nothing.
 */
export function glob(files: FileSystem, root: string, value: string): GlobResult {
  // FiveM ignores empty values, which would confuse its file system.
  if (value === '') return { files: [], found: true }
  if (value.startsWith('@')) return { files: [value], found: true }
  const base = normalizePath(root)
  const search = { found: true }
  const matches: string[] = []
  matchFiles(files, `${base}/${value}`, search, matches)
  const paths = [...new Set(matches)]
    .filter((path) => path.length >= base.length + 1)
    .map((path) => path.slice(base.length + 1))
    .sort(compareUtf8)
  return { files: paths, found: search.found }
}

function matchFiles(files: FileSystem, pattern: string, search: { found: boolean }, out: string[]) {
  const path = normalizePath(pattern)
  const star = path.indexOf('*')
  const before = directoryOf(star === -1 ? path : path.slice(0, star))
  const slash = star === -1 ? -1 : path.indexOf('/', star)
  const after = slash === -1 ? '' : path.slice(slash + 1)
  if (star !== -1 && path[star + 1] === '*' && (star === 0 || path[star - 1] === '/')) {
    // FiveM tries both: ** as one part, and as none.
    for (const skip of [1, 2]) {
      matchFiles(files, path.slice(0, star) + path.slice(star + skip), search, out)
    }
    for (const { name, directory: isDirectory } of match(files, path.slice(0, star + 1), search)) {
      if (isDirectory) matchFiles(files, `${before}/${name}/${path.slice(star)}`, search, out)
    }
    return
  }
  // FiveM leaves out the character before the slash that follows a *.
  for (const { name, directory: isDirectory } of match(
    files,
    slash === -1 ? path : path.slice(0, slash - 1),
    search,
  )) {
    if (slash !== -1 && !isDirectory) continue
    const found = `${before}/${name}`
    if (after !== '') matchFiles(files, `${found}/${after}`, search, out)
    else if (!isDirectory) out.push(found)
  }
}

/**
 * The entries of a directory whose names match the last part of `pattern`,
 * as FiveM finds them. The first search that finds none, unless its pattern
 * starts with * or . and the directory exists, marks the value not found.
 */
function match(files: FileSystem, pattern: string, search: { found: boolean }): FileEntry[] {
  const slash = pattern.lastIndexOf('/')
  const directory = slash === -1 ? pattern : pattern.slice(0, slash)
  const name = pattern.slice(slash + 1)
  const entries = files.list(directory)
  const regex = namePattern(name)
  if (regex === undefined) return []
  const matches =
    entries === undefined
      ? []
      : entries.filter(
          (entry) => entry.name !== '.' && entry.name !== '..' && regex.test(entry.name),
        )
  if (search.found) {
    // Where there is no directory, FiveM tests its pattern on an empty name.
    const has = entries === undefined ? regex.test('') : matches.length > 0
    search.found = has || ((name.startsWith('*') || name.startsWith('.')) && entries !== undefined)
  }
  return matches
}

/** The regular expression FiveM matches names with: ? is any character and * any characters. */
function namePattern(name: string): RegExp | undefined {
  let source = ''
  for (const char of name) {
    if (char === '?') source += '.'
    else if (char === '*') source += '.*'
    else if ('\\^.$|()[]+/'.includes(char)) source += `\\${char}`
    else source += char
  }
  try {
    return new RegExp(`^${source}$`)
  } catch {
    return undefined
  }
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '.' : path.slice(0, slash)
}
