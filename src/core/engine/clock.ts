/** What a clock runs every so many milliseconds. */
interface Timer {
  readonly interval: number
  readonly fn: () => void
  /** When it was added, which its times count from, so that they do not drift. */
  readonly start: number
  /** How many times it ran. */
  runs: number
  /** When it runs next. */
  next: number
}

/**
 * A clock that moves only when it is told to, as tests and the tools of
 * FiveLab move it, and runs what is due at the times it passes: as FiveM's
 * server runs its frames every 50 milliseconds, and clients their game
 * frames. Its time starts at 0, and is in milliseconds, which need not be
 * whole.
 */
export class Clock {
  #now = 0
  readonly #timers: Timer[] = []

  /** Milliseconds since the clock started. */
  get now(): number {
    return this.#now
  }

  /**
   * Runs `fn` every `interval` milliseconds, which must be more than 0,
   * first `interval` from now, and returns what stops it.
   */
  every(interval: number, fn: () => void): () => void {
    if (!(interval > 0)) {
      throw new RangeError(`Clock intervals must be more than 0 ms, not ${interval}`)
    }
    const start = this.#now
    const timer: Timer = { interval, fn, start, runs: 0, next: dueTime(start, interval, 1) }
    this.#timers.push(timer)
    return () => {
      const index = this.#timers.indexOf(timer)
      if (index !== -1) this.#timers.splice(index, 1)
    }
  }

  /**
   * Moves the clock forward by `ms`, through each time that a timer is due
   * on the way, and runs those timers then: by the time they are due, and
   * those due at once in the order they were added. A timer that another
   * stops does not run, one that another adds runs from its own time, and
   * one that throws leaves the clock at its time.
   */
  advance(ms: number): void {
    if (!(ms >= 0)) throw new RangeError(`Clocks move forward, not by ${ms} ms`)
    const end = this.#now + ms
    for (;;) {
      let due: Timer | undefined
      for (const timer of this.#timers) {
        if (timer.next <= end && (due === undefined || timer.next < due.next)) due = timer
      }
      if (due === undefined) break
      this.#now = due.next
      due.runs++
      due.next = dueTime(due.start, due.interval, due.runs + 1)
      due.fn()
    }
    this.#now = end
  }
}

/**
 * When a timer that started at `start` runs for the `run`th time, to the
 * microsecond: the error of floating point, as in 60 times 1000 / 60, which
 * is not quite 1000, stays below it.
 */
function dueTime(start: number, interval: number, run: number): number {
  return Math.round((start + run * interval) * 1000) / 1000
}
