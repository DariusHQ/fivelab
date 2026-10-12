import { compareUtf8 } from '../libc.ts'

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

/** The files of a resource as directories, which globs search as FiveM searches its file system. */
export class FileTree {
  readonly root: string
  /** The entries of each directory, by its normalized path: whether each is a directory. */
  readonly #directories = new Map<string, Map<string, boolean>>()

  /** A tree of the files at `paths` under `root`, the path of the resource. */
  constructor(root: string, paths: Iterable<string>) {
    this.root = normalizePath(root)
    this.#directories.set(this.root, new Map())
    for (const path of paths) {
      let directory = this.root
      const parts = path.split('/')
      parts.forEach((part, i) => {
        const isDirectory = i < parts.length - 1
        this.#directories.get(directory)!.set(part, isDirectory)
        if (!isDirectory) return
        directory = `${directory}/${part}`
        if (!this.#directories.has(directory)) this.#directories.set(directory, new Map())
      })
    }
  }

  /** The entries of the directory at `path`, or undefined if there is none. */
  list(path: string): ReadonlyMap<string, boolean> | undefined {
    return this.#directories.get(path)
  }
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
export function glob(tree: FileTree, value: string): GlobResult {
  // FiveM ignores empty values, which would confuse its file system.
  if (value === '') return { files: [], found: true }
  if (value.startsWith('@')) return { files: [value], found: true }
  const search = { found: true }
  const matches: string[] = []
  matchFiles(tree, `${tree.root}/${value}`, search, matches)
  const files = [...new Set(matches)]
    .filter((path) => path.length >= tree.root.length + 1)
    .map((path) => path.slice(tree.root.length + 1))
    .sort(compareUtf8)
  return { files, found: search.found }
}

function matchFiles(tree: FileTree, pattern: string, search: { found: boolean }, out: string[]) {
  const path = normalizePath(pattern)
  const star = path.indexOf('*')
  const before = directoryOf(star === -1 ? path : path.slice(0, star))
  const slash = star === -1 ? -1 : path.indexOf('/', star)
  const after = slash === -1 ? '' : path.slice(slash + 1)
  if (star !== -1 && path[star + 1] === '*' && (star === 0 || path[star - 1] === '/')) {
    // FiveM tries both: ** as one part, and as none.
    for (const skip of [1, 2]) {
      matchFiles(tree, path.slice(0, star) + path.slice(star + skip), search, out)
    }
    for (const [name, isDirectory] of match(tree, path.slice(0, star + 1), search)) {
      if (isDirectory) matchFiles(tree, `${before}/${name}/${path.slice(star)}`, search, out)
    }
    return
  }
  // FiveM leaves out the character before the slash that follows a *.
  for (const [name, isDirectory] of match(
    tree,
    slash === -1 ? path : path.slice(0, slash - 1),
    search,
  )) {
    if (slash !== -1 && !isDirectory) continue
    const found = `${before}/${name}`
    if (after !== '') matchFiles(tree, `${found}/${after}`, search, out)
    else if (!isDirectory) out.push(found)
  }
}

/**
 * The entries of a directory whose names match the last part of `pattern`,
 * as FiveM finds them. The first search that finds none, unless its pattern
 * starts with * or . and the directory exists, marks the value not found.
 */
function match(tree: FileTree, pattern: string, search: { found: boolean }): [string, boolean][] {
  const slash = pattern.lastIndexOf('/')
  const directory = slash === -1 ? pattern : pattern.slice(0, slash)
  const name = pattern.slice(slash + 1)
  const entries = tree.list(directory)
  const regex = namePattern(name)
  if (regex === undefined) return []
  const matches =
    entries === undefined
      ? []
      : [...entries].filter(([entry]) => entry !== '.' && entry !== '..' && regex.test(entry))
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
