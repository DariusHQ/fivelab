/** The orders FiveM gives callbacks that must run first, and last. */
export const INT32_MIN = -0x80000000
export const INT32_MAX = 0x7fffffff

/** A callback of a hook, given what the hook runs with. Returning false stops the hook. */
export type HookCallback<Args extends readonly unknown[] = []> = (...args: Args) => boolean | void

interface Link<Args extends readonly unknown[]> {
  readonly order: number
  readonly cookie: number
  readonly callback: HookCallback<Args>
  next: Link<Args> | undefined
}

/**
 * Callbacks that run when something happens, such as the start of a
 * resource, or a command that a console has no handler for, as FiveM runs
 * those of its events: by ascending order, and those of the same order as
 * they were connected. A callback that returns false stops the rest, and
 * the hook returns whether none did.
 *
 * Like FiveM's, a running hook finds the next callback before it runs the
 * current one, so a callback connected right after the one running does not
 * run then, while one connected further on does, and one disconnected right
 * after the one running still runs then.
 */
export class Hook<Args extends readonly unknown[] = []> {
  #first: Link<Args> | undefined
  #nextCookie = 0

  /**
   * Connects a callback to run at `order`, as FiveM orders callbacks of its
   * components, and returns its cookie, which disconnects it, as FiveM
   * counts them: from 0.
   */
  connect(callback: HookCallback<Args>, order = 0): number {
    const link: Link<Args> = { order, cookie: this.#nextCookie++, callback, next: undefined }
    if (this.#first === undefined || order < this.#first.order) {
      link.next = this.#first
      this.#first = link
      return link.cookie
    }
    let last = this.#first
    while (last.next !== undefined && last.next.order <= order) last = last.next
    link.next = last.next
    last.next = link
    return link.cookie
  }

  /** Disconnects the callback that `cookie` names, if it is connected. */
  disconnect(cookie: number): void {
    let previous: Link<Args> | undefined
    for (let link = this.#first; link !== undefined; link = link.next) {
      if (link.cookie === cookie) {
        if (previous === undefined) this.#first = link.next
        else previous.next = link.next
        return
      }
      previous = link
    }
  }

  /** Whether a callback is connected, as FiveM's events say when they are tested. */
  get connected(): boolean {
    return this.#first !== undefined
  }

  /** Runs the callbacks with `args` and returns whether none of them returned false. */
  run(...args: Args): boolean {
    let link = this.#first
    while (link !== undefined) {
      const next = link.next
      if (link.callback(...args) === false) return false
      link = next
    }
    return true
  }
}
