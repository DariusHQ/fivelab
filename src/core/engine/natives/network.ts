import { atoi, stoi, stoiError } from '../../libc.ts'
import { defineNative, NativeError, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { SERVER_NET_ID, type Player } from '../session.ts'
import { checkArgument } from './events.ts'

/** The size from which FiveM's server warns about the events it sends clients. */
const LARGE_EVENT = 1_000_000

/** How long FiveM's server waits between warnings about large events, in milliseconds. */
const LARGE_EVENT_WARNINGS = 5000

const NO_PAYLOAD = new Uint8Array(0)

/** The net id of the server on clients, as the latent events they get from it say, unlike the others. */
const LATENT_SERVER_NET_ID = 0

/** What FiveM warns of when scripts send latent events while sv_enableNetEventReassembly is off. */
function reassemblyOff(native: string): string {
  return `${native} requires setr sv_enableNetEventReassembly true\n`
}

/**
 * The payload of a net event: none for a null pointer, which FiveM sends
 * as it is when its length is 0, and reads past otherwise.
 */
function payloadOf(
  ctx: NativeContext,
  native: string,
  payload: Uint8Array | null,
  length: number,
): Uint8Array {
  if (payload !== null) return payload
  if (length !== 0) {
    ctx.diagnose(
      `${native} was given no payload, but a length of ${length}: FiveM would read that many bytes from nowhere, and crash. FiveRunner sends no payload.`,
    )
  }
  return NO_PAYLOAD
}

/** Natives of the events that the server and its clients send each other. */
export function networkNatives(side: Side): NativeDefinition<NativeContext>[] {
  if (side === 'client') {
    return [
      defineNative(
        {
          name: 'TRIGGER_SERVER_EVENT_INTERNAL',
          result: 'void',
          params: ['char* eventName', 'buffer eventPayload', 'int payloadLength'],
        },
        (ctx: NativeContext, eventName, eventPayload, payloadLength) => {
          // FiveM's client does not check the name, which it reads as it sends it.
          if (eventName === null) {
            ctx.diagnose(
              'TriggerServerEventInternal was given no event name: FiveM would read it from nowhere, and crash. FiveRunner sends nothing.',
            )
            return
          }
          const payload = payloadOf(ctx, 'TriggerServerEventInternal', eventPayload, payloadLength)
          const { player } = ctx.manager
          if (player === undefined) {
            ctx.diagnose(
              `TriggerServerEvent sent ${eventName} to no server, as FiveRunner's client is not connected to one.`,
            )
            return
          }
          player.session.server.events.queue(eventName, payload, `net:${player.netId}`)
        },
      ),
      defineNative(
        {
          name: 'TRIGGER_LATENT_SERVER_EVENT_INTERNAL',
          result: 'void',
          params: ['char* eventName', 'buffer eventPayload', 'int payloadLength', 'int bps'],
        },
        (ctx: NativeContext, eventName, eventPayload, payloadLength, bps) => {
          if (!ctx.manager.reassembling) {
            ctx.runtime.emitWarning(
              'natives',
              reassemblyOff('TRIGGER_LATENT_SERVER_EVENT_INTERNAL'),
            )
            return
          }
          if (eventName === null) {
            ctx.diagnose(
              'TriggerLatentServerEventInternal was given no event name: FiveM would read it from nowhere, and crash. FiveRunner sends nothing.',
            )
            return
          }
          const payload = payloadOf(
            ctx,
            'TriggerLatentServerEventInternal',
            eventPayload,
            payloadLength,
          )
          const { player } = ctx.manager
          if (player === undefined) {
            ctx.diagnose(
              `TriggerLatentServerEvent sent ${eventName} to no server, as FiveRunner's client is not connected to one.`,
            )
          }
          const deliveries =
            player === undefined
              ? []
              : [
                  () => {
                    const source = `net:${player.netId}`
                    if (player.state === 'joined')
                      player.session.server.events.queue(eventName, payload, source)
                  },
                ]
          ctx.manager.latent.send(eventName, payload, bps, deliveries)
        },
      ),
    ]
  }
  /** When the server last warned about a large event, as FiveM's keeps it. */
  let lastWarning: number | undefined
  /** Whether the server warned about events sent to the old net ids of players, which FiveM does once. */
  let warnedOfOldNetIds = false
  return [
    defineNative(
      {
        name: 'TRIGGER_CLIENT_EVENT_INTERNAL',
        result: 'void',
        params: [
          'char* eventName',
          'char* eventTarget',
          'buffer eventPayload',
          'int payloadLength',
        ],
      },
      (ctx: NativeContext, eventName, eventTarget, eventPayload, payloadLength) => {
        const name = checkArgument(eventName, 0)
        const target = checkArgument(eventTarget, 1)
        const payload = payloadOf(ctx, 'TriggerClientEventInternal', eventPayload, payloadLength)
        const { manager } = ctx
        const now = manager.time()
        if (
          payload.length >= LARGE_EVENT &&
          (lastWarning === undefined || now - lastWarning >= LARGE_EVENT_WARNINGS)
        ) {
          manager.trace(
            'citizen-server-impl',
            `Warning: sending large event ${name} (${payload.length} bytes). This may cause performance issues. Consider using latent events instead.\n`,
          )
          lastWarning = now
        }
        const session = manager.session
        if (session === undefined) return
        const source = `net:${SERVER_NET_ID}`
        // Only clients that joined have a connection for the event to go through.
        const send = (player: Player) => {
          if (player.state === 'joined') player.client.events.queue(name, payload, source)
        }
        if (target === '-1') {
          for (const player of session.players) send(player)
          return
        }
        const netId = atoi(target)
        const player = session.player(netId)
        if (player === undefined) return
        if (player.netId !== netId && !warnedOfOldNetIds) {
          warnedOfOldNetIds = true
          ctx.runtime.emitWarning(
            'natives',
            `TRIGGER_CLIENT_EVENT_INTERNAL: client ${player.netId} is not the same as the target ${netId}. This happens when the oldId from the playerJoining event is used. Use source instead.\n`,
          )
        }
        send(player)
      },
    ),
    defineNative(
      {
        name: 'TRIGGER_LATENT_CLIENT_EVENT_INTERNAL',
        result: 'void',
        params: [
          'char* eventName',
          'char* eventTarget',
          'buffer eventPayload',
          'int payloadLength',
          'int bps',
        ],
      },
      (ctx: NativeContext, eventName, eventTarget, eventPayload, payloadLength, bps) => {
        const { manager } = ctx
        if (!manager.reassembling) {
          ctx.runtime.emitWarning('natives', reassemblyOff('TRIGGER_LATENT_CLIENT_EVENT_INTERNAL'))
          return
        }
        const name = checkArgument(eventName, 0)
        const target = checkArgument(eventTarget, 1)
        const payload = payloadOf(
          ctx,
          'TriggerLatentClientEventInternal',
          eventPayload,
          payloadLength,
        )
        const netId = stoi(target)
        if (netId === undefined) throw new NativeError(stoiError(target))
        // FiveM sends latent events to the players that joined, by the net ids they have.
        const targets = [...(manager.session?.players ?? [])].filter(
          (player) => player.state === 'joined' && (netId === -1 || player.netId === netId),
        )
        const source = `net:${LATENT_SERVER_NET_ID}`
        const deliveries = targets.map((player) => () => {
          if (player.state === 'joined') player.client.events.queue(name, payload, source)
        })
        manager.latent.send(name, payload, bps, deliveries)
      },
    ),
  ]
}
