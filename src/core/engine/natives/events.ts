import { defineNative, NativeError, type NativeDefinition } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'

/** FiveM's CheckArgument: a null pointer fails the call. */
export function checkArgument<T>(value: T | null, index: number): T {
  if (value === null) throw new NativeError(`Argument at index ${index} was null.`)
  return value
}

/** Natives of FiveM's resource event manager. */
export function eventNatives(): NativeDefinition<NativeContext>[] {
  return [
    // Declared void, it sets whether the event was not canceled, and FiveM's
    // result checks make that a poison value: TriggerEvent returns
    // 2146290430, or false when a handler canceled the event.
    defineNative(
      {
        name: 'TRIGGER_EVENT_INTERNAL',
        result: 'void',
        sets: 'BOOL',
        params: ['char* eventName', 'buffer eventPayload', 'int payloadLength'],
      },
      (ctx: NativeContext, eventName, eventPayload) =>
        ctx.manager.events.trigger(checkArgument(eventName, 0), checkArgument(eventPayload, 1)),
    ),
    defineNative({ name: 'CANCEL_EVENT', result: 'void', params: [] }, (ctx: NativeContext) => {
      ctx.manager.events.cancel()
    }),
    defineNative(
      { name: 'WAS_EVENT_CANCELED', result: 'BOOL', params: [] },
      (ctx: NativeContext) => ctx.manager.events.lastCanceled,
    ),
    defineNative(
      { name: 'REGISTER_RESOURCE_AS_EVENT_HANDLER', result: 'void', params: ['char* eventName'] },
      (ctx: NativeContext, eventName) => {
        const resource = ctx.manager.currentResource
        if (resource === undefined) return
        const name = checkArgument(eventName, 0)
        resource.handledEvents.add(name)
        ctx.manager.events.register(resource.name, name)
      },
    ),
  ]
}
