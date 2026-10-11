import { typeInfo, type ParamType, type ResultType } from './types.ts'

/** What a native's Lua function is generated from. */
export interface WrappedNative {
  readonly hash: bigint
  readonly result: ResultType
  readonly params: readonly { readonly name: string; readonly type: ParamType }[]
}

/** Lua keywords; a parameter with one of these names gets an underscore appended. */
const KEYWORDS = new Set([
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
])

function paramName(name: string): string {
  return KEYWORDS.has(name) ? `${name}_` : name
}

function resultMarker(result: ResultType): string | undefined {
  if (result === 'void') return undefined
  if (result === 'Any*') return '_rl'
  switch (typeInfo(result).kind) {
    case 'bool':
      return '_r'
    case 'string':
      return '_s'
    case 'float':
      return '_rf'
    case 'vector3':
      return '_rv'
    case 'int':
      return '_ri'
    case 'long':
      return '_rl'
    case 'object':
      return '_ro'
    default:
      return undefined
  }
}

/**
 * The Lua code that defines native `name` (the native's own name or an alias)
 * as a function of `Global`, as FiveM generates it (codegen_out_lua.lua).
 * Values pass through as they are, except that strings go through _ts, hashes
 * through _ch, functions through _mfr and objects through _obj. Out-pointers
 * become markers that add results, and a native with just one, as its last
 * parameter, takes its initial value as an argument. The last marker says
 * how to read the result. Everything ends in _in, Citizen.InvokeNative.
 */
export function nativeWrapper(native: WrappedNative, name: string): string {
  const params = native.params.map((param) => ({
    name: paramName(param.name),
    info: typeInfo(param.type),
  }))
  const pointers = params.filter((param) => param.info.pointer).length
  const singlePointer = pointers === 1 && params.at(-1)!.info.pointer
  const list: string[] = []
  const gather: string[] = []
  const args = [`0x${native.hash.toString(16).toUpperCase()}`]
  for (const { name: param, info } of params) {
    if (!info.pointer || singlePointer) list.push(param)
    if (info.pointer) {
      switch (info.kind) {
        case 'int':
        case 'long':
          args.push(singlePointer ? `_ii(${param})` : '_i')
          break
        case 'float':
          args.push(singlePointer ? `_fi(${param})` : '_f')
          break
        case 'vector3':
          args.push('_v')
          break
        default:
          args.push('_i')
      }
      continue
    }
    switch (info.kind) {
      case 'object':
        gather.push(`\tlocal ${param}_bytes, ${param}_len = _obj(${param})\n`)
        args.push(`${param}_bytes, ${param}_len`)
        break
      case 'func':
        args.push(`_mfr(${param})`)
        break
      case 'string':
      case 'buffer':
        args.push(`_ts(${param})`)
        break
      default:
        args.push(info.name === 'Hash' ? `_ch(${param})` : param)
    }
  }
  const marker = resultMarker(native.result)
  if (marker !== undefined) args.push(marker)
  return (
    `function Global.${name}(${list.join(', ')})\n` +
    gather.join('') +
    `\treturn _in(${args.join(', ')})\n` +
    'end\n'
  )
}
