import type { LuaValue } from '../lua/index.ts'
import {
  invokeNative,
  prepareNative,
  type NativeCaller,
  type NativeDeclaration,
  type PreparedNative,
} from './invoker.ts'
import { hashString, luaName } from './names.ts'
import type { ArgValue, ParamType, ResultType, ResultValue } from './types.ts'

/** A native with the names scripts call it by. */
export interface NativeDefinition<Ctx> extends NativeDeclaration<Ctx> {
  /** Other names of the native in Lua, such as earlier names or N_0x hash names. */
  readonly aliases: readonly string[]
}

/** A parameter as written in a declaration: its type, a space and its name. */
export type ParamSpec = `${ParamType} ${string}`

type ParamTypeOf<S extends string> = S extends `${infer T extends ParamType} ${string}` ? T : never

/** The values an implementation receives for parameters declared as P. */
export type NativeArgs<P extends readonly string[]> = {
  -readonly [K in keyof P]: ArgValue<ParamTypeOf<P[K]>>
}

export interface NativeSpec<R extends ResultType, P extends readonly ParamSpec[]> {
  /** The declared name, such as GET_ENTITY_COORDS. */
  readonly name: string
  /** The 64-bit hash. CFX natives leave it out: theirs is the hash of their name. */
  readonly hash?: bigint
  readonly result: R
  readonly params: P
  /** Declared names of aliases, such as names the native had before. */
  readonly aliases?: readonly string[]
}

/**
 * Defines a native implementation. Parameters are written as in FiveM's
 * declarations, and the implementation receives their JavaScript values:
 *
 *   defineNative(
 *     { name: 'GET_ENTITY_COORDS', hash: 0x3fef770d40960d5an, result: 'Vector3',
 *       params: ['Entity entity', 'BOOL alive'] },
 *     (ctx, entity, alive) => ...,
 *   )
 */
export function defineNative<Ctx, R extends ResultType, const P extends readonly ParamSpec[]>(
  spec: NativeSpec<R, P>,
  impl: (ctx: Ctx, ...args: NativeArgs<P>) => ResultValue<R>,
): NativeDefinition<Ctx> {
  const params = spec.params.map((param) => {
    const space = param.indexOf(' ')
    return { type: param.slice(0, space) as ParamType, name: param.slice(space + 1) }
  })
  return {
    name: spec.name,
    hash: spec.hash ?? BigInt(hashString(spec.name)),
    result: spec.result,
    params,
    aliases: (spec.aliases ?? []).map(luaName),
    impl: impl as (ctx: Ctx, ...args: never[]) => unknown,
  }
}

/** A native with its names in Lua. */
export interface RegisteredNative<Ctx> extends PreparedNative<Ctx> {
  /** The global Lua calls the native by. */
  readonly luaName: string
  readonly aliases: readonly string[]
}

/**
 * The natives of one kind of FiveM process (client or server), by hash and by
 * the names Lua calls them by.
 */
export class NativeRegistry<Ctx extends NativeCaller> {
  readonly #byHash = new Map<bigint, RegisteredNative<Ctx>>()
  readonly #byName = new Map<string, RegisteredNative<Ctx>>()

  /**
   * Adds natives. One with the hash or the Lua name of a native already here
   * replaces it and takes over its aliases, so an implementation can replace
   * a native from the catalog without repeating its aliases.
   */
  register(...natives: readonly NativeDefinition<Ctx>[]): void {
    for (const definition of natives) {
      const name = luaName(definition.name)
      const hash = BigInt.asUintN(64, definition.hash)
      const replaced = this.#byHash.get(hash) ?? this.#byName.get(name)
      const aliases = new Set(definition.aliases)
      if (replaced !== undefined) {
        this.#byHash.delete(replaced.hash)
        for (const old of [replaced.luaName, ...replaced.aliases]) {
          this.#byName.delete(old)
          aliases.add(old)
        }
      }
      aliases.delete(name)
      const native: RegisteredNative<Ctx> = {
        ...prepareNative({ ...definition, hash }),
        luaName: name,
        aliases: [...aliases],
      }
      this.#byHash.set(native.hash, native)
      for (const alias of [name, ...native.aliases]) this.#byName.set(alias, native)
    }
  }

  byHash(hash: bigint): RegisteredNative<Ctx> | undefined {
    return this.#byHash.get(BigInt.asUintN(64, hash))
  }

  /** The native a Lua global stands for, under its name or an alias. */
  byName(name: string): RegisteredNative<Ctx> | undefined {
    return this.#byName.get(name)
  }

  get size(): number {
    return this.#byHash.size
  }

  /** Runs a call cfxlua.wasm marshalled; see invokeNative. */
  invoke(ctx: Ctx, ptr: number): LuaValue[] {
    return invokeNative(ctx, ptr, (hash) => this.#byHash.get(hash))
  }
}
