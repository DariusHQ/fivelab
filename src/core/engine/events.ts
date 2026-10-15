import { Hook } from '../hook.ts'
import type { ResourceManager } from './manager.ts'
import { pack } from './msgpack.ts'
import type { Resource } from './resource.ts'

/** An event to trigger at the next tick. */
interface QueuedEvent {
  readonly name: string
  readonly payload: Uint8Array
  readonly source: string
  readonly target: Resource | undefined
}

/**
 * The events of a process, handled as FiveM's resource event manager
 * handles them:
 *
 * - An event goes to the resources whose scripts registered a handler for
 *   it, or for "*": first to those of "*", then to those of the event, each
 *   newest registration first. FiveM keeps registrations for as long as the
 *   process runs, so a resource that handled an event once keeps getting it.
 * - CancelEvent cancels the innermost event being triggered, and
 *   WasEventCanceled tells whether the last event to finish was canceled.
 * - Queued events are triggered at the next tick, with those they queue.
 */
export class EventManager {
  /**
   * Runs as the process triggers each event, before its resources get it,
   * with its name, payload and source, for embedders to watch events by.
   */
  readonly onTrigger = new Hook<[name: string, payload: Uint8Array, source: string]>()
  readonly #manager: ResourceManager
  /** The names of the resources registered for each event, newest first. */
  readonly #resources = new Map<string, string[]>()
  /** The events being triggered, innermost last. */
  readonly #triggering: { canceled: boolean }[] = []
  #lastCanceled = false
  readonly #queue: QueuedEvent[] = []
  /** Whether onResourceStop goes to no resource; see holdingResourceStops. */
  #holdingStops = false

  constructor(manager: ResourceManager) {
    this.#manager = manager
  }

  /**
   * Triggers the events of a resource's start and stop with its name, as
   * FiveM's resource event component does:
   *
   * - onResourceStarting before the resource starts. Canceling it keeps the
   *   resource from starting.
   * - onResourceStart once its scripts loaded.
   * - onResourceStop before its runtime closes.
   * - on<Side>ResourceStart and on<Side>ResourceStop, queued as it starts and
   *   stops, so that they come at the next tick, when a stopped resource is
   *   no longer there to get its own.
   */
  attach(resource: Resource): void {
    const side = this.#manager.side === 'server' ? 'Server' : 'Client'
    const args = () => pack([resource.name])
    resource.onBeforeStart.connect(() => this.trigger('onResourceStarting', args()), -10_000)
    resource.onStart.connect(() => this.queue(`on${side}ResourceStart`, args()))
    resource.onStart.connect(() => {
      this.trigger('onResourceStart', args())
    }, 99_999)
    resource.onStop.connect(() => this.queue(`on${side}ResourceStop`, args()))
    resource.onStop.connect(() => {
      this.trigger('onResourceStop', args())
    }, -99_999)
  }

  /** Registers a resource for an event, once, as RegisterResourceAsEventHandler does. */
  register(resource: string, event: string): void {
    const resources = this.#resources.get(event)
    if (resources === undefined) this.#resources.set(event, [resource])
    else if (!resources.includes(resource)) resources.unshift(resource)
  }

  /**
   * Triggers an event now and returns whether it was not canceled. `source`
   * is "" for events of the process itself, and `target`, when given, is the
   * only resource to get the event.
   */
  trigger(name: string, payload: Uint8Array, source = '', target?: Resource): boolean {
    const event = { canceled: false }
    this.#triggering.push(event)
    try {
      if (this.#holdingStops && name === 'onResourceStop') return true
      this.onTrigger.run(name, payload, source)
      if (target !== undefined) {
        target.handleEvent(name, payload, source)
      } else if (!name.startsWith('__cfx_nui:')) {
        // NUI callbacks only ever go to their resource.
        for (const key of ['*', name]) {
          for (const resource of [...(this.#resources.get(key) ?? [])]) {
            // Events go to the resources that handle them, never to those that provide their names.
            this.#manager.getResource(resource, false)?.handleEvent(name, payload, source)
          }
        }
      }
    } finally {
      this.#triggering.pop()
      this.#lastCanceled = event.canceled
    }
    return !event.canceled
  }

  /**
   * Runs `fn` while onResourceStop goes to no resource, as FiveM's clients
   * hold the event back as they reset their resources at the end of their
   * game session, when scripts could do nothing of note.
   */
  holdingResourceStops(fn: () => void): void {
    this.#holdingStops = true
    try {
      fn()
    } finally {
      this.#holdingStops = false
    }
  }

  /** Queues an event to trigger at the next tick; see trigger. */
  queue(name: string, payload: Uint8Array, source = '', target?: Resource): void {
    this.#queue.push({ name, payload, source, target })
  }

  /** Cancels the innermost event being triggered, if any. */
  cancel(): void {
    const event = this.#triggering.at(-1)
    if (event !== undefined) event.canceled = true
  }

  /** Whether the last event to finish was canceled. */
  get lastCanceled(): boolean {
    return this.#lastCanceled
  }

  /** Triggers the queued events, and those they queue, as FiveM does every tick. */
  tick(): void {
    for (let event = this.#queue.shift(); event !== undefined; event = this.#queue.shift()) {
      this.trigger(event.name, event.payload, event.source, event.target)
    }
  }
}
