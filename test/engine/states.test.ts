import { describe, expect, it } from 'vitest'

import type { NativeContext } from '../../src/core/engine/index.ts'
import { pack } from '../../src/core/engine/msgpack.ts'
import { defineNative, type NativeDefinition } from '../../src/core/natives/index.ts'
import type { Side } from '../../src/core/natives/index.ts'
import { createProcess, type TestProcess } from './helpers.ts'

/** Starts a resource running `source` and returns the lines written but those of every start. */
function start(proc: TestProcess, name: string, source: string): string[] {
  proc.add(name, { 'main.lua': source }).start()
  const starting = [
    `[citizen-scripting-core] Creating script environments for ${name}`,
    `[resources] Started resource ${name}`,
  ]
  return proc.take().filter((line) => !starting.includes(line))
}

/**
 * A process whose state bags give "bag/key" for each key, and record the
 * values set and the entities whose bags were ensured. Networked entities
 * have their handle plus 100 as network id, and are those above 100 on
 * clients. The local player has 0 as id, and 12 as server id.
 */
async function createStates(side: Side): Promise<{ proc: TestProcess; calls: string[] }> {
  const calls: string[] = []
  const natives: NativeDefinition<NativeContext>[] = [
    defineNative(
      {
        name: 'SET_STATE_BAG_VALUE',
        result: 'void',
        params: [
          'char* bagName',
          'char* keyName',
          'buffer valueData',
          'int valueLength',
          'BOOL replicated',
        ],
      },
      (_ctx: NativeContext, bag, key, value, length, replicated) => {
        calls.push(`set ${bag} ${key} [${Array.from(value!).join(',')}] ${length} ${replicated}`)
      },
    ),
    defineNative(
      { name: 'GET_STATE_BAG_VALUE', result: 'object', params: ['char* bagName', 'char* key'] },
      (_ctx: NativeContext, bag, key) => pack(`${bag}/${key}`),
    ),
    defineNative(
      { name: 'ENSURE_ENTITY_STATE_BAG', result: 'void', params: ['int entity'] },
      (_ctx: NativeContext, entity) => {
        calls.push(`ensure ${entity}`)
      },
    ),
    defineNative(
      { name: 'NETWORK_GET_NETWORK_ID_FROM_ENTITY', result: 'int', params: ['int entity'] },
      (_ctx: NativeContext, entity) => entity + 100,
    ),
    defineNative(
      { name: 'NETWORK_GET_ENTITY_FROM_NETWORK_ID', result: 'int', params: ['int netId'] },
      (_ctx: NativeContext, netId) => netId - 100,
    ),
  ]
  if (side === 'client') {
    natives.push(
      defineNative(
        {
          name: 'NETWORK_GET_ENTITY_IS_NETWORKED',
          hash: 0xc7827959479dcc78n,
          result: 'BOOL',
          params: ['int entity'],
        },
        (_ctx: NativeContext, entity) => entity > 100,
      ),
      defineNative({ name: 'PLAYER_ID', result: 'int', params: [] }, () => 0),
      defineNative(
        { name: 'GET_PLAYER_SERVER_ID', result: 'int', params: ['int player'] },
        (_ctx: NativeContext, player) => (player === 0 ? 12 : -1),
      ),
    )
  }
  return { proc: await createProcess({ side, natives }), calls }
}

describe('state bags', () => {
  it('pack the values they set, which servers replicate when they assign them', async () => {
    for (const side of ['server', 'client'] as const) {
      const { proc, calls } = await createStates(side)
      expect(
        start(
          proc,
          'a',
          `GlobalState.x = 5
GlobalState:set('y', 'v', ${side === 'client'})
print(GlobalState.z)`,
        ),
      ).toEqual(['[script:a] global/z'])
      expect(calls).toEqual([
        `set global x [5] 1 ${side === 'server'}`,
        `set global y [161,118] 2 ${side === 'client'}`,
      ])
    }
  })

  it('of entities and players are the state fields of Entity and Player', async () => {
    const { proc, calls } = await createStates('server')
    expect(
      start(
        proc,
        'a',
        `print(Entity(5).state.k, Player(3).state.k, Player('4').state.k)
print(Entity('x'), Player(true), Entity(5).other, Player(3).other)
print(pcall(function() Entity(5).x = 1 end))
print(pcall(function() Player(3).x = 1 end))
print(LocalPlayer)`,
      ),
    ).toEqual([
      '[script:a] entity:105/k\tplayer:3/k\tplayer:4/k',
      '[script:a] x\ttrue\tnil\tnil',
      '[script:a] false\t@a/main.lua:3: Setting values on Entity is not supported at this time.',
      '[script:a] false\t@a/main.lua:4: Setting values on Player is not supported at this time.',
      '[script:a] nil',
    ])
    // Servers ensure the state bags of entities they are asked for.
    expect(calls).toEqual(['ensure 5'])
  })

  it('of local entities and of the local player on clients', async () => {
    const { proc, calls } = await createStates('client')
    expect(
      start(proc, 'a', `print(Entity(105).state.k, Entity(7).state.k, LocalPlayer.state.k)`),
    ).toEqual(['[script:a] entity:205/k\tlocalEntity:7/k\tplayer:12/k'])
    expect(calls).toEqual(['ensure 7'])
  })

  it('belong to entities and players that msgpack packs as their ids', async () => {
    const { proc } = await createStates('server')
    expect(
      start(
        proc,
        'a',
        `print(msgpack.pack(Entity(5)) == '\\xc7\\x03\\x29105', msgpack.pack(Player(3)) == '\\xd4\\x2a3')
local entity, player = table.unpack(msgpack.unpack('\\x92\\xc7\\x03\\x29105\\xd4\\x2a3'))
print(rawget(entity, '__data'), rawget(player, '__data'), entity.state.k, player.state.k)`,
      ),
    ).toEqual(['[script:a] true\ttrue', '[script:a] 5\t3\tentity:105/k\tplayer:3/k'])
  })
})
