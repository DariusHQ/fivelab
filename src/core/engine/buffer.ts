import { compareUtf8 } from '../libc.ts'
import type { ResourceManager } from './manager.ts'
import { pack } from './msgpack.ts'

/** How many prints FiveM's servers keep for GetConsoleBuffer. */
export const KEPT_PRINTS = 1500

/**
 * How deep listeners may print while they hear of prints. FiveM's servers
 * tell them of what they print as they print it, so a listener that prints
 * whatever it hears of recurses until the server crashes.
 */
export const MAX_LISTENER_DEPTH = 16

interface Listener {
  readonly resource: string
  readonly ref: string
  /** The order it was added in, among all. */
  readonly order: number
}

/**
 * What FiveM's servers keep of what their console prints, for scripts: the
 * last prints, which GetConsoleBuffer gives, and the console listeners of
 * resources, which RegisterConsoleListener adds. Listeners hear of each
 * print as it prints, in the order of the names of their resources as C++
 * orders strings, then in the order they were added.
 */
export class ConsoleBuffer {
  readonly #manager: ResourceManager
  readonly #prints: string[] = []
  readonly #listeners: Listener[] = []
  #nextOrder = 0
  /** How deep listeners are printing while they hear of prints. */
  #depth = 0
  /** Whether listeners printed too deep, which keeps them from hearing of prints until the first is told. */
  #tooDeep = false

  constructor(manager: ResourceManager) {
    this.#manager = manager
  }

  /** The prints kept, as one text. */
  get text(): string {
    return this.#prints.join('')
  }

  /** Keeps a print, and tells the listeners of it. */
  add(channel: string, text: string): void {
    this.#prints.push(text)
    if (this.#prints.length > KEPT_PRINTS) this.#prints.shift()
    if (this.#tooDeep) return
    if (this.#depth === MAX_LISTENER_DEPTH) {
      this.#tooDeep = true
      // Listeners print as their resources.
      const printing = this.#manager.currentResource!
      this.#manager.output.diagnose(
        printing.name,
        `A console listener printed while it heard of prints, ${MAX_LISTENER_DEPTH} deep: FiveM tells listeners of what they print as they print it, so a listener that prints whatever it hears of recurses until the server crashes. FiveLab told listeners of no more prints until the first.`,
      )
      return
    }
    this.#depth++
    try {
      // FiveM takes the listener after each one when it is done with it,
      // so listeners that come later hear of the print even if they were
      // added while it was told.
      for (let listener = this.#listeners[0]; listener !== undefined;) {
        this.#manager.invokeFunctionReference(listener.ref, pack([channel, text]))
        const done = listener
        listener = this.#listeners.find((other) => compareListeners(other, done) > 0)
      }
    } finally {
      if (--this.#depth === 0) this.#tooDeep = false
    }
  }

  /** Adds a listener of a resource, after those of resources whose names come before its. */
  listen(resource: string, ref: string): void {
    const listener = { resource, ref, order: this.#nextOrder++ }
    let index = this.#listeners.length
    while (index > 0 && compareListeners(listener, this.#listeners[index - 1]!) < 0) index--
    this.#listeners.splice(index, 0, listener)
  }

  /** Removes the listeners of a resource. */
  forget(resource: string): void {
    for (let i = this.#listeners.length - 1; i >= 0; i--) {
      if (this.#listeners[i]!.resource === resource) this.#listeners.splice(i, 1)
    }
  }
}

function compareListeners(a: Listener, b: Listener): number {
  return compareUtf8(a.resource, b.resource) || a.order - b.order
}
