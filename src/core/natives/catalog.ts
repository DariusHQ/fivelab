import client from './catalog/client.json' with { type: 'json' }
import server from './catalog/server.json' with { type: 'json' }
import { parseParam, type NativeDefinition } from './registry.ts'
import type { ResultType } from './types.ts'

/** A kind of FiveM process; each has natives of its own. */
export type Side = 'client' | 'server'

/** A native as scripts/generate-natives.ts writes it. */
type Entry = [hash: string, names: string[], docLines: number, result: string, params: string[]]

const catalogs: Record<Side, { readonly natives: readonly unknown[] }> = { client, server }

/**
 * The natives FiveM has on a side, from the catalog generated from the
 * CitizenFX typings, without implementations: calls to them do nothing and
 * return zero values. Their parameters and results are as close to FiveM's
 * as the typings tell, which makes their Lua functions return as many
 * values, of the same kinds, as FiveM's.
 */
export function catalogNatives<Ctx>(side: Side): NativeDefinition<Ctx>[] {
  return (catalogs[side].natives as Entry[]).map(([hash, names, docLines, result, params]) => {
    const [luaName = '', ...aliases] = names
    return {
      name: luaName,
      hash: BigInt(`0x${hash}`),
      result: result as ResultType,
      params: params.map(parseParam),
      luaName,
      aliases,
      docLines,
      impl: null,
    }
  })
}
