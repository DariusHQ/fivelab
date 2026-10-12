import { compareUtf8, lowerAscii } from '../libc.ts'
import type { ConsoleOutput } from './commands.ts'

/** Whether an access control entry allows its principal access to its object, or denies it. */
export type Access = 'allow' | 'deny'

/** An access control entry, or ACE, as FiveM's add_ace adds them. */
export interface AccessControlEntry {
  readonly principal: string
  readonly object: string
  readonly access: Access
}

/** A principal that inherits the access of another, as FiveM's add_principal adds them. */
export interface PrincipalInheritance {
  readonly child: string
  readonly parent: string
}

/** The principal that every principal is, which FiveM checks when no code runs as another. */
export const EVERYONE = 'builtin.everyone'

/**
 * FiveM's security context, se::Context: what principals, such as
 * resource.<name> or system.console, may access, as access control entries
 * on objects, such as command.<name>, and the principals that they inherit
 * access from. Principals and objects are lowercased, as C's tolower does,
 * so only ASCII letters.
 */
export class Security {
  /**
   * Where checks print what they find, as FiveM's do while its se_debug is
   * on, or undefined while it is off.
   */
  debug: ConsoleOutput | undefined
  /** The entries, ordered by object as C++ orders strings, then as they were added. */
  readonly #entries: AccessControlEntry[] = []
  /** The inheritances, ordered by child as C++ orders strings, then as they were added. */
  readonly #inheritances: PrincipalInheritance[] = []
  /** The principals that code runs as, the innermost first. */
  readonly #principals: string[] = []

  /** The entries, ordered by object, then as they were added, as FiveM's list_aces lists them. */
  get entries(): readonly AccessControlEntry[] {
    return [...this.#entries]
  }

  /** The inheritances, ordered by child, then as they were added, as FiveM's list_principals lists them. */
  get inheritances(): readonly PrincipalInheritance[] {
    return [...this.#inheritances]
  }

  /** The principals that code runs as, the innermost first. */
  get principals(): readonly string[] {
    return [...this.#principals]
  }

  addEntry(principal: string, object: string, access: Access): void {
    const entry = { principal: lowerAscii(principal), object: lowerAscii(object), access }
    insertSorted(this.#entries, entry, (other) => compareUtf8(entry.object, other.object))
  }

  /** Removes the entries for an object that give a principal an access. */
  removeEntry(principal: string, object: string, access: Access): void {
    const [p, o] = [lowerAscii(principal), lowerAscii(object)]
    removeWhere(this.#entries, (e) => e.principal === p && e.object === o && e.access === access)
  }

  addInheritance(child: string, parent: string): void {
    const inheritance = { child: lowerAscii(child), parent: lowerAscii(parent) }
    insertSorted(this.#inheritances, inheritance, (other) =>
      compareUtf8(inheritance.child, other.child),
    )
  }

  removeInheritance(child: string, parent: string): void {
    const [c, p] = [lowerAscii(child), lowerAscii(parent)]
    removeWhere(this.#inheritances, (i) => i.child === c && i.parent === p)
  }

  /** Runs `fn` as `principal`, as FiveM's se::ScopedPrincipal does. */
  runAs<T>(principal: string, fn: () => T): T {
    this.#principals.unshift(lowerAscii(principal))
    try {
      return fn()
    } finally {
      this.#principals.shift()
    }
  }

  /**
   * Whether the code that runs may access `object`: whether one of the
   * principals it runs as may, or, if it runs as none, everyone.
   */
  check(object: string): boolean {
    if (this.#principals.length === 0) return this.checkPrincipal(EVERYONE, object)
    return this.#principals.some((principal) => this.checkPrincipal(principal, object))
  }

  /**
   * Whether `principal` may access `object`: whether an entry allows it,
   * everyone or a principal that it inherits from access to the object or to
   * one of its parents, such as command for command.say, and none denies it.
   */
  checkPrincipal(principal: string, object: string): boolean {
    const [who, what] = [lowerAscii(principal), lowerAscii(object)]
    const principals = this.#principalsOf(who)
    // The object, then each of its parents: what comes before its dots.
    const objects = [what]
    for (let last = what; last.includes('.'); objects.push(last)) {
      last = last.slice(0, last.lastIndexOf('.'))
    }
    const { debug } = this
    const test = `TEST ACL [${who} -> ${what}]`
    let allowed = false
    for (const parent of objects) {
      for (const entry of this.#entries) {
        if (entry.object !== parent || !principals.has(entry.principal)) continue
        const ace = `${test} ACE [${entry.principal} ${entry.object}]`
        if (entry.access === 'deny') {
          debug?.printDeveloper('security', `${ace} -> DENY-ALWAYS\n`)
          debug?.print('security', `${test} -> DENY-ALWAYS\n`)
          return false
        }
        debug?.printDeveloper('security', `${ace} -> ALLOW\n`)
        allowed = true
      }
    }
    debug?.print('security', `${test} -> ${allowed ? 'ALLOW' : 'DENY'}\n`)
    return allowed
  }

  /**
   * The principals that `principal` is, as FiveM finds them: itself,
   * everyone, and those it inherits from, through others too. Starting with
   * everyone, FiveM does not look for the parents of everyone, unless
   * `principal` is everyone.
   */
  #principalsOf(principal: string): Set<string> {
    const found = new Set([principal, EVERYONE])
    const pending = [principal]
    while (pending.length > 0) {
      const child = pending.pop()!
      for (const { child: of, parent } of this.#inheritances) {
        if (of !== child || found.has(parent)) continue
        found.add(parent)
        pending.push(parent)
      }
    }
    return found
  }
}

/** Inserts `item` after the items it does not order before. */
function insertSorted<T>(items: T[], item: T, compare: (other: T) => number): void {
  let index = items.length
  while (index > 0 && compare(items[index - 1]!) < 0) index--
  items.splice(index, 0, item)
}

function removeWhere<T>(items: T[], matches: (item: T) => boolean): void {
  for (let i = items.length - 1; i >= 0; i--) {
    if (matches(items[i]!)) items.splice(i, 1)
  }
}
