import { atoi } from '../../libc.ts'
import { defineNative, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { DropReason, type Player } from '../session.ts'
import { checkArgument } from './events.ts'

/** What FiveM's GET_PLAYER_LAST_MSG gives for no player. */
const NO_LAST_MSG = 0x7fffffff

/**
 * The player that the first argument of a native of players names, as
 * FiveM's MakeClientFunction finds it: by the net id that atoi reads.
 * Natives give their default value for no player.
 */
function playerOf(ctx: NativeContext, playerSrc: string | null): Player | undefined {
  return ctx.manager.session?.player(atoi(checkArgument(playerSrc, 0)))
}

/** The value at `index` of a list of a player, or none out of it, as FiveM's natives of players read them. */
function at(list: readonly string[], index: number): string | null {
  return list[index] ?? null
}

/** Natives of the players of servers, which only servers have. */
export function playerNatives(side: Side): NativeDefinition<NativeContext>[] {
  if (side === 'client') return []
  /** The players as GetNumPlayerIndices last listed them, which GetPlayerFromIndex indexes for all resources. */
  let listed: Player[] = []
  return [
    defineNative(
      { name: 'GET_PLAYER_NAME', result: 'char*', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => playerOf(ctx, playerSrc)?.name ?? null,
    ),
    defineNative(
      { name: 'DOES_PLAYER_EXIST', result: 'BOOL', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => {
        const player = playerOf(ctx, playerSrc)
        return player !== undefined && player.netId === atoi(playerSrc!)
      },
    ),
    defineNative(
      { name: 'GET_PLAYER_GUID', result: 'char*', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => playerOf(ctx, playerSrc)?.guid ?? null,
    ),
    defineNative(
      { name: 'GET_NUM_PLAYER_IDENTIFIERS', result: 'int', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => playerOf(ctx, playerSrc)?.identifiers.length ?? 0,
    ),
    defineNative(
      {
        name: 'GET_PLAYER_IDENTIFIER',
        result: 'char*',
        params: ['char* playerSrc', 'int identiferIndex'],
      },
      (ctx: NativeContext, playerSrc, index) => {
        const player = playerOf(ctx, playerSrc)
        return player === undefined ? null : at(player.identifiers, index)
      },
    ),
    defineNative(
      {
        name: 'GET_PLAYER_IDENTIFIER_BY_TYPE',
        result: 'char*',
        params: ['char* playerSrc', 'char* identifierType'],
      },
      (ctx: NativeContext, playerSrc, identifierType) => {
        const player = playerOf(ctx, playerSrc)
        if (player === undefined) return null
        // FiveM takes the first identifier that starts with the type, so license finds license2: too.
        const type = checkArgument(identifierType, 1)
        return player.identifiers.find((identifier) => identifier.startsWith(type)) ?? null
      },
    ),
    defineNative(
      { name: 'GET_NUM_PLAYER_TOKENS', result: 'int', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => playerOf(ctx, playerSrc)?.tokens.length ?? 0,
    ),
    defineNative(
      { name: 'GET_PLAYER_TOKEN', result: 'char*', params: ['char* playerSrc', 'int index'] },
      (ctx: NativeContext, playerSrc, index) => {
        const player = playerOf(ctx, playerSrc)
        return player === undefined ? null : at(player.tokens, index)
      },
    ),
    defineNative(
      { name: 'GET_PLAYER_ENDPOINT', result: 'char*', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => playerOf(ctx, playerSrc)?.endpoint ?? null,
    ),
    defineNative(
      { name: 'GET_PLAYER_PING', result: 'int', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => playerOf(ctx, playerSrc)?.ping ?? 0,
    ),
    defineNative(
      { name: 'GET_PLAYER_LAST_MSG', result: 'int', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => {
        const player = playerOf(ctx, playerSrc)
        if (player === undefined) return NO_LAST_MSG
        return Math.trunc(ctx.manager.time()) - player.lastSeen
      },
    ),
    defineNative(
      { name: 'GET_PLAYER_TIME_ONLINE', result: 'int', params: ['char* playerSrc'] },
      (ctx: NativeContext, playerSrc) => {
        const player = playerOf(ctx, playerSrc)
        return player === undefined ? 0 : Math.trunc((player.lastSeen - player.firstSeen) / 1000)
      },
    ),
    // Declared void, it sets whether it dropped the player.
    defineNative(
      {
        name: 'DROP_PLAYER',
        result: 'void',
        sets: 'BOOL',
        params: ['char* playerSrc', 'char* reason'],
      },
      (ctx: NativeContext, playerSrc, reason) => {
        const player = playerOf(ctx, playerSrc)
        // FiveM drops no player that has no net id yet.
        if (player === undefined || !player.connected) return false
        const resource = ctx.manager.currentResource?.name ?? ''
        player.session.drop(player, checkArgument(reason, 1), resource, DropReason.resource)
        return true
      },
    ),
    defineNative(
      {
        name: 'IS_PLAYER_ACE_ALLOWED',
        result: 'BOOL',
        params: ['char* playerSrc', 'char* object'],
      },
      (ctx: NativeContext, playerSrc, object) => {
        const player = playerOf(ctx, playerSrc)
        if (player === undefined) return false
        const what = checkArgument(object, 1)
        // FiveM checks as the player alone, not as those the code runs as.
        const { security } = ctx.manager
        return player.principals.some((principal) => security.checkPrincipal(principal, what))
      },
    ),
    defineNative(
      { name: 'GET_NUM_PLAYER_INDICES', result: 'int', params: [] },
      (ctx: NativeContext) => {
        // FiveM lists the players that have their net ids.
        listed = Array.from(ctx.manager.session?.players ?? []).filter(({ connected }) => connected)
        return listed.length
      },
    ),
    defineNative(
      { name: 'GET_PLAYER_FROM_INDEX', result: 'char*', params: ['int index'] },
      (_ctx: NativeContext, index) => {
        const player = listed[index]
        // The list keeps players that dropped since, which FiveM finds no more.
        if (player === undefined || player.session.player(player.netId) !== player) return null
        return String(player.netId)
      },
    ),
  ]
}
