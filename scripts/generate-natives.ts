/**
 * Generates FiveLab's catalog of FiveM natives (src/core/natives/catalog)
 * from the typings Cfx.re publishes for FiveM's JavaScript runtime,
 * @citizenfx/client and @citizenfx/server, at the versions package.json pins.
 *
 *   npm run build:natives               writes the catalog
 *   npm run build:natives -- --check    fails if it is out of date
 *
 * FiveM's build generates the typings and its Lua natives from the same
 * declarations and in the same order, so the typings tell which Lua names
 * each native has, which native a name that two of them share ends up with,
 * and how many lines of documentation start the Lua file for each name. They
 * tell parameters and results only as JavaScript sees them, which is enough
 * for natives FiveLab does not implement: those return zero values, and the
 * catalog gives each the parameters and results that make its Lua function
 * return as many values, of the same kinds, as FiveM's. Hashes are in the
 * typings only for natives with N_0x names; the others get the hash of
 * their name, which is the real one for CFX natives.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { declaredName, hashInName, hashString } from '../src/core/natives/names.ts'

const root = resolve(import.meta.dirname, '..')

const sides = [
  { side: 'client', pkg: '@citizenfx/client', typings: 'natives_universal.d.ts' },
  { side: 'server', pkg: '@citizenfx/server', typings: 'natives_server.d.ts' },
] as const

/** One `declare function` of the typings. */
interface Declaration {
  readonly name: string
  readonly params: string
  readonly result: string
  readonly doc: string
}

/**
 * Reads the declarations of a typings file, grouped by native: the native's
 * own name first, then its aliases, which repeat its documentation and
 * signature. A blank line ends each native.
 */
function parseTypings(text: string): Declaration[][] {
  const source = text.replaceAll('\r\n', '\n')
  const pattern = /(\/\*\*\n[^]*?\*\/\n)?declare function (\w+)\(([^)]*)\): (.*);\n(\n)?/y
  const natives: Declaration[][] = []
  let declarations: Declaration[] = []
  while (pattern.lastIndex < source.length) {
    const at = pattern.lastIndex
    const match = pattern.exec(source)
    if (match === null) {
      throw new Error(
        `Unexpected text at offset ${at}: ${JSON.stringify(source.slice(at, at + 80))}`,
      )
    }
    const [, doc = '', name = '', params = '', result = '', end] = match
    declarations.push({ name, params, result, doc })
    if (end !== undefined) {
      const [own] = declarations
      for (const alias of declarations) {
        if (
          alias.params !== own!.params ||
          alias.result !== own!.result ||
          alias.doc !== own!.doc
        ) {
          throw new Error(`${alias.name} differs from ${own!.name}, of which it is an alias`)
        }
      }
      natives.push(declarations)
      declarations = []
    }
  }
  if (declarations.length > 0) throw new Error('The typings end inside a native')
  return natives
}

/**
 * The lines of documentation that start FiveM's Lua file for a native: the
 * lines of its summary. The doc comment in the typings has the same lines,
 * then @param and @return lines, whose descriptions may span lines.
 */
function docLines(doc: string): number {
  if (doc === '') return 0
  const lines = doc.split('\n').slice(1, -2)
  const tags = lines.findIndex((line) => /^ \* @(param|return) /.test(line))
  const summary = tags < 0 ? lines : lines.slice(0, tags)
  const tagged = tags < 0 ? [] : lines.slice(tags)
  if (summary.length === 0 || summary.some((line) => !line.startsWith(' * '))) {
    throw new Error(`Unexpected documentation:\n${doc}`)
  }
  if (tagged.some((line) => line.startsWith(' * ') && !/^ \* @(param|return) /.test(line))) {
    throw new Error(`Documentation continues after its tags:\n${doc}`)
  }
  return summary.length
}

/** Parameter names the typings prefix with _, as they are TypeScript keywords. */
const RENAMED = new Set([
  'any',
  'as',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'module',
  'new',
  'null',
  'number',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'require',
  'return',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

/** FiveLab types for the JavaScript types of values. */
const VALUE_TYPES: Record<string, string> = {
  number: 'int',
  boolean: 'BOOL',
  string: 'char*',
  'string | number': 'Hash',
  Function: 'func',
  any: 'object',
}

/** FiveLab types for the JavaScript types of results. */
const RESULT_TYPES: Record<string, string> = {
  number: 'int',
  boolean: 'BOOL',
  string: 'char*',
  'number[]': 'Vector3',
  any: 'object',
}

/** FiveLab types for the JavaScript types of out-pointers. */
const POINTER_TYPES: Record<string, string> = {
  number: 'int*',
  'number[]': 'Vector3*',
  'any /* actually bool */': 'BOOL*',
}

function lookup(types: Record<string, string>, type: string, name: string): string {
  const mapped = types[type]
  if (mapped === undefined) throw new Error(`${name}: unexpected type ${type}`)
  return mapped
}

/**
 * The parameters and result FiveLab declares a native of the catalog with,
 * chosen so that its Lua function returns what FiveM's returns when the
 * native returns zeros: as many values, of the same kinds. The typings give
 * a native's out-pointers as more results, after its own, and leave them out
 * of its parameters, except for an only out-pointer that is the last
 * parameter: that one stays, optional when parameters come before it. As
 * where the other out-pointers go is lost, they come first here, where none
 * can be taken for that kind. Numbers are integers, and the optional
 * parameter points to a float, as FiveM checks the initial value of a float
 * less strictly than an integer's.
 */
function signature(declaration: Declaration): { result: string; params: string[] } {
  const { name } = declaration
  const values = declaration.params === '' ? [] : declaration.params.split(', ')
  const params: string[] = []
  const names = new Set<string>()
  values.forEach((value, index) => {
    const match = /^(\w+)(\??): (.+)$/.exec(value)
    if (match === null) throw new Error(`${name}: unexpected parameter ${value}`)
    const [, typed = '', optional, type = ''] = match
    const param = typed.startsWith('_') && RENAMED.has(typed.slice(1)) ? typed.slice(1) : typed
    if (names.has(param)) throw new Error(`${name}: two parameters named ${param}`)
    names.add(param)
    if (optional === '') {
      params.push(`${lookup(VALUE_TYPES, type, name)} ${param}`)
    } else if (type === 'number' && index === values.length - 1) {
      params.push(`float* ${param}`)
    } else {
      throw new Error(`${name}: unexpected optional parameter ${value}`)
    }
  })
  const single = values.at(-1)?.includes('?:') === true
  const results =
    declaration.result === 'void'
      ? []
      : declaration.result.startsWith('[')
        ? declaration.result.slice(1, -1).split(', ')
        : [declaration.result]
  if (single && results.pop() !== 'number') throw new Error(`${name}: no result for its pointer`)
  if (single && results.length > 1) throw new Error(`${name}: pointers besides the last one`)
  // Out-pointers to booleans only show as `any /* actually bool */`, never as results.
  let result = 'void'
  let pointers = results
  if (results.length > 0 && !results[0]!.startsWith('any /*')) {
    result = lookup(RESULT_TYPES, results[0]!, name)
    pointers = results.slice(1)
  }
  const out = pointers.map((type, index) => {
    const param = `out${index + 1}`
    if (names.has(param)) throw new Error(`${name}: a parameter is named ${param}`)
    return `${lookup(POINTER_TYPES, type, name)} ${param}`
  })
  return { result, params: [...out, ...params] }
}

/** The hash FiveM files a native's Lua code under, of its exact name (HashRageString). */
function fileHash(name: string): number {
  let hash = 0
  for (const byte of new TextEncoder().encode(name)) {
    hash = (hash + (byte < 0x80 ? byte : byte - 0x100)) >>> 0
    hash = (hash + (hash << 10)) >>> 0
    hash = (hash ^ (hash >>> 6)) >>> 0
  }
  hash = (hash + (hash << 3)) >>> 0
  hash = (hash ^ (hash >>> 11)) >>> 0
  return (hash + (hash << 15)) >>> 0
}

/**
 * The native's hash. Game natives on clients are named N_0x and their hash
 * until they get a name, which keeps the old one as an alias, so the hash is
 * the one in the native's N_0x name, or in its N_0x alias if it has just one.
 * Other natives get the hash of their declared name: the real hash of CFX
 * natives, which all server natives are, and a stand-in for game natives.
 */
function nativeHash(declarations: readonly Declaration[], game: boolean): bigint {
  const [own] = declarations
  if (game) {
    const named = hashInName(own!.name)
    if (named !== undefined) return named
    const aliases = new Set(declarations.flatMap(({ name }) => hashInName(name) ?? []))
    if (aliases.size === 1) return [...aliases][0]!
  } else if (hashInName(own!.name) !== undefined) {
    throw new Error(`${own!.name} is a CFX native without a name`)
  }
  return BigInt(hashString(declaredName(own!.name)))
}

type CatalogEntry = [
  hash: string,
  names: string[],
  docLines: number,
  result: string,
  params: string[],
]

/** The catalog entries of the natives in a typings file, in its order. */
function generate(text: string, game: boolean): CatalogEntry[] {
  const natives = parseTypings(text)
  // FiveM writes a Lua file for each name in turn, so where natives share a
  // name, the last one keeps it.
  const owners = new Map<string, number>()
  natives.forEach((declarations, index) => {
    for (const { name } of declarations) owners.set(name, index)
  })
  const files = new Map<number, string>()
  for (const name of owners.keys()) {
    const other = files.get(fileHash(name))
    if (other !== undefined) throw new Error(`${name} and ${other} have the same file hash`)
    files.set(fileHash(name), name)
  }
  const hashes = new Map<bigint, string>()
  return natives.map((declarations, index): CatalogEntry => {
    const [own] = declarations
    const names = [...new Set(declarations.map(({ name }) => name))].filter(
      (name) => owners.get(name) === index,
    )
    if (names.length === 0) throw new Error(`${own!.name} keeps none of its names`)
    const hash = nativeHash(declarations, game)
    const other = hashes.get(hash)
    if (other !== undefined) throw new Error(`${own!.name} has the hash of ${other}`)
    hashes.set(hash, own!.name)
    const { result, params } = signature(own!)
    return [hash.toString(16), names, docLines(own!.doc), result, params]
  })
}

const check = process.argv.includes('--check')
for (const { side, pkg, typings } of sides) {
  const dir = join(root, 'node_modules', pkg)
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version: string
  }
  const source = `${pkg}@${version}`
  const entries = generate(readFileSync(join(dir, typings), 'utf8'), side === 'client')
  const lines = entries.map((entry) => `    ${JSON.stringify(entry)}`)
  const catalog = `{\n  "source": ${JSON.stringify(source)},\n  "natives": [\n${lines.join(',\n')}\n  ]\n}\n`
  const file = `src/core/natives/catalog/${side}.json`
  const path = join(root, file)
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== catalog) {
      process.stderr.write(`${file} is out of date: run npm run build:natives\n`)
      process.exitCode = 1
    }
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, catalog)
    const names = entries.reduce((count, [, list]) => count + list.length, 0)
    process.stdout.write(`${file}: ${entries.length} natives, ${names} names, from ${source}\n`)
  }
}
