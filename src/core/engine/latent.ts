import type { ResourceManager } from './manager.ts'

/** How many bytes of a latent event FiveM's network sends in each fragment, as its reassembled events of version 2 have them. */
export const LATENT_FRAGMENT = 2047

/** How large FiveM's latent events may be, with their names and the length of these: less than 65536 fragments. */
export const LATENT_LIMIT = 65536 * LATENT_FRAGMENT

/** The bytes per second that FiveM sends latent events at when it is given none. */
const DEFAULT_RATE = 25_000

/** The bytes per second, and the size, from which FiveM warns about the latent events it sends. */
const FAST_RATE = 10_000_000
const LARGE_EVENT = 50_000_000

/** How long FiveM waits between warnings about fast latent events, in milliseconds. */
const WARNINGS = 5000

interface Transfer {
  /** How long the last fragment of the event takes after the first, in milliseconds. */
  readonly delay: number
  /** When the first fragment went, by the clock of the sender. */
  start: number | undefined
  readonly deliver: () => void
}

/**
 * The latent events that a process sends, as FiveM's event reassembly
 * component sends them: in fragments of 2047 bytes, the first at the next
 * network tick of the sender, which comes at the end of each of its ticks,
 * and each other as long after the one before as a fragment takes at the
 * rate of the event, in whole milliseconds. An event reaches a target once
 * its last fragment would have, for the target to handle it at its next
 * tick.
 */
export class LatentEvents {
  readonly #manager: ResourceManager
  readonly #transfers: Transfer[] = []
  /** When the process last warned about a fast latent event, as FiveM keeps it. */
  #lastWarning: number | undefined

  constructor(manager: ResourceManager) {
    this.#manager = manager
  }

  /**
   * Sends an event at `rate` bytes per second, as FiveM's TriggerEventV2
   * does, with a function for each target that gives it the event: unless
   * the event, with its name, is too large to send, which it says. It warns
   * about large events sent at almost any rate.
   */
  send(name: string, payload: Uint8Array, rate: number, deliveries: readonly (() => void)[]): void {
    const manager = this.#manager
    const bytesPerSecond = rate <= 0 ? DEFAULT_RATE : rate
    const size = new TextEncoder().encode(name).length + 2 + payload.length
    if (size >= LATENT_LIMIT) {
      manager.trace(
        'citizen-resources-core',
        `Event ${name} is too large to be sent. Total size: ${size}, max size: ${LATENT_LIMIT}.\n`,
      )
      return
    }
    const now = manager.time()
    if (
      bytesPerSecond >= FAST_RATE &&
      payload.length >= LARGE_EVENT &&
      (this.#lastWarning === undefined || now - this.#lastWarning >= WARNINGS)
    ) {
      manager.trace(
        'citizen-resources-core',
        `Warning: sending large event ${name} (${payload.length} bytes) with almost unrestricted bitrate (${bytesPerSecond} b/s). This may cause performance issues. Consider decreasing objects sizes or bitrate.\n`,
      )
      this.#lastWarning = now
    }
    const fragments = Math.ceil(size / LATENT_FRAGMENT)
    // FiveM keeps the time a fragment takes in whole milliseconds.
    const latency = Math.trunc(1000 / (bytesPerSecond / LATENT_FRAGMENT))
    for (const deliver of deliveries) {
      this.#transfers.push({ delay: (fragments - 1) * latency, start: undefined, deliver })
    }
  }

  /** Gives their targets the events whose last fragment arrived, as FiveM's network tick sends fragments. */
  tick(): void {
    const now = this.#manager.time()
    for (const transfer of [...this.#transfers]) {
      transfer.start ??= now
      if (now - transfer.start < transfer.delay) continue
      this.#transfers.splice(this.#transfers.indexOf(transfer), 1)
      transfer.deliver()
    }
  }
}
