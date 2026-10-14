import { Hook } from '../hook.ts'
import { compareUtf8 } from '../libc.ts'
import { unpackObject, type MsgpackObject } from './msgpack.ts'

/**
 * What the handlers of the changes of state bags get, as FiveM's
 * OnStateBagChange gives it: who made the change, the bag, the key, the
 * value as msgpack-c unpacked it, and whether the change replicates.
 */
export type StateBagChange = [
  source: number,
  bag: string,
  key: string,
  value: MsgpackObject,
  replicated: boolean,
]

/** Sends a key of a state bag to a peer, as FiveM's game interfaces send state bag packets. */
export type StateBagSender = (peer: number, bag: string, key: string, data: Uint8Array) => void

/** The first byte of msgpack's nil, which deletes the key it is set to. */
const NIL = 0xc0

/**
 * A state bag, as FiveM's StateBagImpl: keys with msgpack values, ordered
 * by the bytes of the keys, which it sends the peers that it routes to, or
 * those of its component, and takes from its owner alone.
 */
export class StateBag {
  readonly name: string
  readonly #states: StateBags
  readonly #useParentTargets: boolean
  readonly #data = new Map<string, Uint8Array>()
  /** The peers it routes to, which a std::set orders. */
  readonly #routing = new Set<number>()
  #owner: number | undefined

  /** @internal State bags come from StateBags.register. */
  constructor(states: StateBags, name: string, useParentTargets: boolean) {
    this.#states = states
    this.name = name
    this.#useParentTargets = useParentTargets
  }

  get(key: string): Uint8Array | undefined {
    return this.#data.get(key)
  }

  has(key: string): boolean {
    return this.#data.has(key)
  }

  /** The keys, ordered by their bytes. */
  keys(): string[] {
    return [...this.#data.keys()].sort(compareUtf8)
  }

  /** The peer that alone may set the keys of the bag from elsewhere, -1 for none, or undefined for any. */
  get owner(): number | undefined {
    return this.#owner
  }

  set owner(peer: number | undefined) {
    this.#owner = peer
  }

  /**
   * Sets a key to msgpack `data` for `source`, as FiveM's SetKey does: once
   * the handlers of changes took it, unless one refused it, or the data are
   * no msgpack that they could get. nil deletes the key. A change that
   * changes something replicates when `replicated` says so.
   */
  set(source: number, key: string, data: Uint8Array, replicated: boolean): void {
    const { onChange } = this.#states
    if (onChange.connected) {
      let value: MsgpackObject
      try {
        value = unpackObject(data)
      } catch {
        return
      }
      if (!onChange.run(source, this.name, key, value, replicated)) return
    }
    const old = this.#data.get(key)
    const nil = data[0] === NIL
    if (old === undefined) {
      // A bag that has no such key sends no nil, which would only come back to delete it.
      if (nil) return
      this.#data.set(key, data.slice())
    } else if (nil) {
      this.#data.delete(key)
    } else if (equal(data, old)) {
      return
    } else {
      this.#data.set(key, data.slice())
    }
    if (replicated) {
      const targets = this.#useParentTargets ? this.#states.targets : this.#routingTargets()
      for (const target of targets) this.#states.send(target, this.name, key, data)
    }
  }

  /** Routes the bag to a peer too, which gets all of its keys. */
  addRoutingTarget(peer: number): void {
    if (this.#routing.has(peer)) return
    this.#routing.add(peer)
    this.sendAll(peer)
  }

  removeRoutingTarget(peer: number): void {
    this.#routing.delete(peer)
  }

  /** @internal Sends a peer all the keys of the bag. */
  sendAll(peer: number): void {
    for (const key of this.keys()) this.#states.send(peer, this.name, key, this.#data.get(key)!)
  }

  /** @internal Sends a new target of the component all the keys, unless the bag routes elsewhere. */
  sendAllInitial(peer: number): void {
    if (this.#routing.size > 0 && !this.#routing.has(peer)) return
    this.sendAll(peer)
  }

  #routingTargets(): number[] {
    return [...this.#routing].sort((a, b) => a - b)
  }
}

/**
 * The state bags of a process, as FiveM's StateBagComponent keeps them: by
 * name, with the peers they replicate to, and handlers of their changes.
 * Bags that peers send keys of and that the process has not are created
 * as they come when their names have a prefix that it may create them for.
 */
export class StateBags {
  /** Runs before a key of a bag changes, which a callback that returns false refuses. */
  readonly onChange = new Hook<StateBagChange>()
  /** Whether the bags are those of a server, which replicate what they take from clients. */
  readonly server: boolean
  readonly #send: StateBagSender
  readonly #bags = new Map<string, StateBag>()
  readonly #targets = new Set<number>()
  readonly #prefixes: (readonly [prefix: string, useParentTargets: boolean])[] = []

  constructor(server: boolean, send: StateBagSender) {
    this.server = server
    this.#send = send
  }

  /** The peers that the bags that route to them all replicate to. */
  get targets(): readonly number[] {
    return [...this.#targets]
  }

  /** The bag named `name`, if there is one. */
  get(name: string): StateBag | undefined {
    return this.#bags.get(name)
  }

  /** The bag named `name`, which it creates unless there is one. */
  register(name: string, useParentTargets = false): StateBag {
    let bag = this.#bags.get(name)
    if (bag === undefined) {
      bag = new StateBag(this, name, useParentTargets)
      this.#bags.set(name, bag)
    }
    return bag
  }

  /** Removes a bag, as FiveM does with the last reference to it. */
  remove(name: string): void {
    this.#bags.delete(name)
  }

  /** Removes all the bags, as FiveM's Reset does. */
  reset(): void {
    this.#bags.clear()
  }

  /** Adds a peer that bags may replicate to, which gets the keys of those that do not route elsewhere. */
  registerTarget(peer: number): void {
    if (this.#targets.has(peer)) return
    this.#targets.add(peer)
    for (const bag of [...this.#bags.values()]) bag.sendAllInitial(peer)
  }

  /** Removes a peer, to which no bag routes any more. */
  unregisterTarget(peer: number): void {
    this.#targets.delete(peer)
    for (const bag of this.#bags.values()) bag.removeRoutingTarget(peer)
  }

  /** Lets peers send keys of bags whose names start with `prefix`, which it creates as they come. */
  addPreCreatePrefix(prefix: string, useParentTargets: boolean): void {
    this.#prefixes.push([prefix, useParentTargets])
  }

  /**
   * Takes a key that a peer sent, as FiveM's HandlePacketV2 does: in the
   * bag of its name, which it creates if a prefix lets it, if the bag has
   * no owner or the peer owns it. It replicates on servers. Packets without
   * a bag, key or data hold nothing.
   */
  receive(source: number, name: string, key: string, data: Uint8Array): void {
    if (name === '' || key === '' || data.length === 0) return
    let bag = this.#bags.get(name)
    if (bag === undefined) {
      const prefix = this.#prefixes.find(([start]) => name.startsWith(start))
      if (prefix === undefined) return
      bag = this.register(name, prefix[1])
    }
    if (bag.owner === undefined || bag.owner === source) bag.set(source, key, data, this.server)
  }

  /** @internal Called by the bags as they send a key to a peer. */
  send(peer: number, bag: string, key: string, data: Uint8Array): void {
    // FiveM sends no empty keys or values.
    if (key !== '' && data.length > 0) this.#send(peer, bag, key, data)
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
