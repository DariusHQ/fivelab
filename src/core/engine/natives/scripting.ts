import { defineNative, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'

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
      { name: 'IS_DUPLICITY_VERSION', result: 'BOOL', params: [] },
      (ctx: NativeContext) => ctx.manager.side === 'server',
    ),
    side === 'client' ? clientGameTimer : serverGameTimer,
  ]
}
