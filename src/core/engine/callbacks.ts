import { Extension, pack, unpackObject, type MsgpackObject } from './msgpack.ts'

/** What the references to the callbacks of FiveM's own code name as their resource. */
export const CALLBACK_RESOURCE = '_cfx_internal'

/** The id of FiveM's runtime of callbacks, 'CBRT', which the references it duplicates name. */
const CALLBACK_RUNTIME_ID = 0x43425254

const encoder = new TextEncoder()
const NO_RESULTS = pack([])

/** A callback of a process's own code, which gets what scripts call it with. */
export type Callback = (args: MsgpackObject) => void

interface Entry {
  readonly callback: Callback
  /** How many references hold the callback, which goes once none does. */
  holders: number
}

/**
 * The callbacks of a process's own code that scripts call as functions, as
 * FiveM's resource callback component keeps them: by references of the
 * form _cfx_internal:0:<index>, from 1 on. A callback goes once the last
 * reference that held it is deleted, and those that no reference held yet
 * stay.
 */
export class Callbacks {
  readonly #entries = new Map<number, Entry>()
  #next = 1

  /** A reference to a new callback, packed as FiveM packs them, in extension 11. */
  create(callback: Callback): Extension {
    const index = this.#next++
    this.#entries.set(index, { callback, holders: 0 })
    return new Extension(11, encoder.encode(`${CALLBACK_RESOURCE}:0:${index}`))
  }

  /**
   * Calls the callback at `index` with the arguments that msgpack packed,
   * and returns no results, packed, or null if there is no such callback.
   */
  call(index: number, args: Uint8Array): Uint8Array | null {
    const entry = this.#entries.get(index)
    if (entry === undefined) return null
    entry.callback(unpackObject(args))
    return NO_RESULTS
  }

  /** Counts another holder of the callback at `index`, and returns the reference it keeps, or null without one. */
  duplicate(index: number): string | null {
    const entry = this.#entries.get(index)
    if (entry === undefined) return null
    entry.holders++
    return `${CALLBACK_RESOURCE}:${CALLBACK_RUNTIME_ID}:${index}`
  }

  /** Takes a holder of the callback at `index` away, and the callback once none holds it. */
  delete(index: number): void {
    const entry = this.#entries.get(index)
    if (entry === undefined) return
    if (--entry.holders <= 0) this.#entries.delete(index)
  }
}
