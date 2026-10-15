import { atoi } from '../../libc.ts'
import { defineNative, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import type { ResourceManager } from '../manager.ts'
import { pack, packObject, type MsgpackObject } from '../msgpack.ts'
import { checkArgument } from './events.ts'

const encoder = new TextEncoder()

/** What FiveM warns of when client scripts set replicated keys while state bags are in strict mode. */
const STRICT_MODE =
  "StateBags can't be modified from the client, because the StateBag strict mode is enabled. Disable it using setr sv_stateBagStrictMode false\n"

/** A msgpack string of `text`. */
function str(text: string): MsgpackObject {
  return { type: 'str', bytes: encoder.encode(text) }
}

/** Natives of FiveM's state bags, as its scripting component gives them. */
export function stateBagNatives(side: Side): NativeDefinition<NativeContext>[] {
  /** The references to the functions of the handlers of changes, by their cookies, which they hold. */
  const handlers = new Map<number, string>()
  /** Removes a handler of changes, which lets go of its function, as FiveM's FunctionRef does as it goes. */
  const removeHandler = (manager: ResourceManager, cookie: number) => {
    manager.states.onChange.disconnect(cookie)
    const ref = handlers.get(cookie)
    if (ref === undefined) return
    handlers.delete(cookie)
    manager.deleteFunctionReference(ref)
  }
  const natives = [
    defineNative(
      { name: 'GET_STATE_BAG_VALUE', result: 'object', params: ['char* bagName', 'char* key'] },
      (ctx: NativeContext, bagName, key) => {
        const name = checkArgument(bagName, 0)
        const keyName = checkArgument(key, 1)
        return ctx.manager.states.get(name)?.get(keyName) ?? pack(null)
      },
    ),
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
      // FiveM checks that the length fits the value, which comes with as many bytes.
      (ctx: NativeContext, bagName, keyName, valueData, _valueLength, replicated) => {
        const name = checkArgument(bagName, 0)
        const key = checkArgument(keyName, 1)
        const data = checkArgument(valueData, 2)
        const { manager } = ctx
        if (side === 'client' && replicated && manager.strictStateBags) {
          ctx.runtime.emitWarning('natives', STRICT_MODE)
          return
        }
        manager.states.get(name)?.set(0, key, data, replicated)
      },
    ),
    defineNative(
      {
        name: 'ADD_STATE_BAG_CHANGE_HANDLER',
        result: 'int',
        params: ['char* keyFilter', 'char* bagFilter', 'func handler'],
      },
      (ctx: NativeContext, keyFilter, bagFilter, handler) => {
        const key = keyFilter ?? ''
        const bag = bagFilter ?? ''
        const ref = checkArgument(handler, 2)
        const { manager, resource } = ctx
        // FiveM's handler holds the function, as its FunctionRef does.
        manager.duplicateFunctionReference(ref)
        const cookie = manager.states.onChange.connect(
          (source, bagName, keyName, value, isReplicated) => {
            if ((key === '' || keyName === key) && (bag === '' || bagName === bag)) {
              const args: MsgpackObject = {
                type: 'array',
                items: [
                  str(bagName),
                  str(keyName),
                  value,
                  { type: source < 0 ? 'negative' : 'positive', value: BigInt(source) },
                  { type: 'boolean', value: isReplicated },
                ],
              }
              manager.invokeFunctionReference(ref, packObject(args))
            }
          },
        )
        handlers.set(cookie, ref)
        resource.onStop.connect(() => removeHandler(manager, cookie))
        return cookie
      },
    ),
    defineNative(
      { name: 'REMOVE_STATE_BAG_CHANGE_HANDLER', result: 'void', params: ['int cookie'] },
      (ctx: NativeContext, cookie) => removeHandler(ctx.manager, cookie),
    ),
    defineNative(
      { name: 'STATE_BAG_HAS_KEY', result: 'BOOL', params: ['char* bagName', 'char* key'] },
      (ctx: NativeContext, bagName, key) => {
        const name = checkArgument(bagName, 0)
        const keyName = checkArgument(key, 1)
        return ctx.manager.states.get(name)?.has(keyName) ?? false
      },
    ),
    defineNative(
      { name: 'GET_STATE_BAG_KEYS', result: 'object', params: ['char* bagName'] },
      (ctx: NativeContext, bagName) => {
        const name = checkArgument(bagName, 0)
        return pack(ctx.manager.states.get(name)?.keys() ?? [])
      },
    ),
  ]
  if (side === 'client') return natives
  return [
    ...natives,
    defineNative(
      { name: 'GET_PLAYER_FROM_STATE_BAG_NAME', result: 'int', params: ['char* bagName'] },
      (ctx: NativeContext, bagName) => {
        const name = checkArgument(bagName, 0)
        if (!name.startsWith('player:')) return 0
        // FiveM finds players by any net id they had, and gives the one they have.
        return ctx.manager.session?.player(atoi(name.slice(7)))?.netId ?? 0
      },
    ),
    defineNative(
      { name: 'GET_ENTITY_FROM_STATE_BAG_NAME', result: 'int', params: ['char* bagName'] },
      (_ctx: NativeContext, bagName) => {
        checkArgument(bagName, 0)
        // FiveRunner has no entities, which FiveM's bags of entities name.
        return 0
      },
    ),
  ]
}
