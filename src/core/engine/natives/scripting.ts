import { defineNative, hashString, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { checkArgument } from './events.ts'

/**
 * The game's GET_HASH_KEY. Its Lua function hashes names without calling
 * it, as FiveM's does, so only Citizen.InvokeNative gets here, where FiveLab
 * hashes as FiveM's server does, and takes NULL for "".
 */
const clientHashKey = defineNative(
  { name: 'GET_HASH_KEY', hash: 0xd24d37cc275948ccn, result: 'Hash', params: ['bytes string'] },
  (_ctx: NativeContext, string) => (string === null ? 0 : hashString(string)),
)

/** FiveM's server hashes names as joaat does, with ASCII letters lowercased. */
const serverHashKey = defineNative(
  { name: 'GET_HASH_KEY', result: 'int', params: ['bytes model'] },
  (_ctx: NativeContext, model) => hashString(checkArgument(model, 0)),
)

/** The game's timer: an unsigned 32-bit count of milliseconds that scripts read as an int. */
const clientGameTimer = defineNative(
  { name: 'GET_GAME_TIMER', hash: 0x9cd27b0045628463n, result: 'int', params: [] },
  (ctx: NativeContext) => Math.trunc(ctx.manager.time()) | 0,
)

/** Milliseconds since the server started. */
const serverGameTimer = defineNative(
  { name: 'GET_GAME_TIMER', result: 'long', params: [] },
  (ctx: NativeContext) => Math.trunc(ctx.manager.time()),
)

/** Natives about the script runtimes and the process they run in. */
export function scriptingNatives(side: Side): NativeDefinition<NativeContext>[] {
  return [
    defineNative(
      { name: 'GET_CURRENT_RESOURCE_NAME', result: 'char*', params: [] },
      (ctx: NativeContext) => ctx.manager.currentResource?.name ?? null,
    ),
    defineNative(
      { name: 'GET_INVOKING_RESOURCE', result: 'char*', params: [] },
      (ctx: NativeContext) => ctx.manager.invokingResource?.name ?? null,
    ),
    defineNative(
      { name: 'GET_INSTANCE_ID', result: 'int', params: [] },
      (ctx: NativeContext) => ctx.runtime.host.instanceId,
    ),
    defineNative(
      { name: 'IS_DUPLICITY_VERSION', result: 'BOOL', params: [] },
      (ctx: NativeContext) => ctx.manager.side === 'server',
    ),
    defineNative(
      { name: 'FORMAT_STACK_TRACE', result: 'char*', params: ['object traceData'] },
      (ctx: NativeContext, traceData) => ctx.manager.formatStackTrace(traceData),
    ),
    side === 'client' ? clientGameTimer : serverGameTimer,
    side === 'client' ? clientHashKey : serverHashKey,
  ]
}
