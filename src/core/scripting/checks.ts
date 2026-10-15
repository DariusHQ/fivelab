import { LuaArgumentError, type HostArgs } from '../lua/index.ts'
import { LUA_TNIL, LUA_TNONE } from '../lua/abi.ts'

const decoder = new TextDecoder()

/** Raises luaL_typeerror for argument `index`, which is not of `expected` type. */
export function typeError(args: HostArgs, index: number, expected: string): never {
  throw new LuaArgumentError(index, `${expected} expected, got ${args.typeName(index)}`)
}

/** Whether an argument is none or nil, which luaL_opt takes for a missing one. */
export function isNoneOrNil(args: HostArgs, index: number): boolean {
  const type = args.type(index)
  return type === LUA_TNONE || type === LUA_TNIL
}

/** An argument as luaL_checklstring takes it: the bytes of a string, or of a number as Lua writes it. */
export function checkString(args: HostArgs, index: number): Uint8Array {
  return args.stringBytes(index) ?? typeError(args, index, 'string')
}

/** An argument as luaL_optlstring takes it, or undefined when there is none. */
export function optionalString(args: HostArgs, index: number): Uint8Array | undefined {
  return isNoneOrNil(args, index) ? undefined : checkString(args, index)
}

/** The bytes of a string up to its first NUL, as C reads the strings it gets. */
export function untilNul(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0)
  return end === -1 ? bytes : bytes.subarray(0, end)
}

/** An argument as luaL_checkstring gives it to C, which reads up to its first NUL, decoded. */
export function checkCString(args: HostArgs, index: number): string {
  return decoder.decode(untilNul(checkString(args, index)))
}

/** An argument as luaL_checkinteger takes it. */
export function checkInteger(args: HostArgs, index: number): bigint {
  if (args.isIntegral(index)) return args.integer(index)
  if (args.isNumber(index)) {
    throw new LuaArgumentError(index, 'number has no integer representation')
  }
  return typeError(args, index, 'number')
}

/**
 * Which of `options` an argument names, as luaL_checkoption finds it, which
 * reads up to its first NUL, and takes `fallback` for none when there is one.
 */
export function checkOption(
  args: HostArgs,
  index: number,
  fallback: string | undefined,
  options: readonly string[],
): number {
  const name =
    fallback !== undefined && isNoneOrNil(args, index) ? fallback : checkCString(args, index)
  const found = options.indexOf(name)
  if (found === -1) throw new LuaArgumentError(index, `invalid option '${name}'`)
  return found
}
