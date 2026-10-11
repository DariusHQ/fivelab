/** The orders FiveM gives callbacks that must run first, and last. */
export const INT32_MIN = -0x80000000
export const INT32_MAX = 0x7fffffff

/** A callback of a hook. Returning false stops the hook. */
export type HookCallback = () => boolean | void

interface Link {
  readonly order: number
  readonly callback: HookCallback
  next: Link | undefined
}

/**
 * Callbacks that run when something happens to a resource, such as its
 * start, as FiveM runs those of its resources' events: by ascending order,
 * and those of the same order as they were connected. A callback that
 * returns false stops the rest, and the hook returns whether none did.
 *
 * Like FiveM's, a running hook finds the next callback before it runs the
 * current one, so a callback connected right after the one running does not
 * run then, while one connected further on does.
 */
export class Hook {
  #first: Link | undefined

  /** Connects a callback to run at `order`, as FiveM orders callbacks of its components. */
  connect(callback: HookCallback, order = 0): void {
    const link: Link = { order, callback, next: undefined }
    if (this.#first === undefined || order < this.#first.order) {
      link.next = this.#first
      this.#first = link
      return
    }
    let last = this.#first
    while (last.next !== undefined && last.next.order <= order) last = last.next
    link.next = last.next
    last.next = link
  }

  /** Runs the callbacks and returns whether none of them returned false. */
  run(): boolean {
    let link = this.#first
    while (link !== undefined) {
      const next = link.next
      if (link.callback() === false) return false
      link = next
    }
    return true
  }
}
