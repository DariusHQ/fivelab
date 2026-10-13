import type { ResourceManager } from './manager.ts'
import { pack } from './msgpack.ts'

/** The net id of what FiveM's servers send clients, which is the source of the events that clients get. */
export const SERVER_NET_ID = 0xffff

/** Why FiveM's servers drop players, as playerDropped gets it. */
export const DropReason = {
  resource: 1,
  client: 2,
  server: 3,
  clientReplaced: 4,
  connectionTimedOut: 5,
  connectionTimedOutWithPendingCommands: 6,
  serverShutdown: 7,
  stateBagRateLimit: 8,
  netEventRateLimit: 9,
  latentNetEventRateLimit: 10,
  commandRateLimit: 11,
  oneSyncTooManyMissedFrames: 12,
  netGameEventRateLimit: 13,
} as const

/** What FiveM's servers name as the resource that dropped players that quit. */
export const CLIENT_DROP_RESOURCE = '__cfx_internal:client'

/** What FiveM's servers name as the resource that dropped players that they dropped themselves. */
export const SERVER_DROP_RESOURCE = '__cfx_internal:server'

/** The net id after `id`, as FiveM's servers count them: from 1 up to 65534, then from 1 again. */
export function netIdAfter(id: number): number {
  // FiveM keeps 65535 for the server, and gives no player 0.
  return id + 1 === SERVER_NET_ID ? 1 : id + 1
}

/** Who a client is to the server it connects to. */
export interface PlayerIdentity {
  /** The name the client plays by: player by default. */
  readonly name?: string
  /** The GUID the client sends: by default, the net id it gets. */
  readonly guid?: string
  /** The identifiers of the player, such as license:... or ip:..., in order. None by default. */
  readonly identifiers?: readonly string[]
  /** The tokens of the client, none by default. */
  readonly tokens?: readonly string[]
  /** The IP address the client connects from, 127.0.0.1 by default. */
  readonly endpoint?: string
}

/** A client connected to the server of a session, as FiveM's server keeps them. */
export class Player {
  readonly session: Session
  /** The process of the client. */
  readonly client: ResourceManager
  /** The id the server knows the client by, which is the source of the events it sends. */
  readonly netId: number
  readonly name: string
  readonly guid: string
  readonly identifiers: readonly string[]
  readonly tokens: readonly string[]
  readonly endpoint: string
  /** The round-trip time to the client, in milliseconds as ENet measures it, which hosts may set. */
  ping = 0
  /** When the server first heard from the client, in whole milliseconds by its clock. */
  readonly firstSeen: number
  #lastSeen: number
  #dropping = false

  /** @internal Players come from Session.connect. */
  constructor(session: Session, client: ResourceManager, netId: number, identity: PlayerIdentity) {
    this.session = session
    this.client = client
    this.netId = netId
    this.name = identity.name ?? 'player'
    this.guid = identity.guid ?? String(netId)
    this.identifiers = [...(identity.identifiers ?? [])]
    this.tokens = [...(identity.tokens ?? [])]
    this.endpoint = identity.endpoint ?? '127.0.0.1'
    this.firstSeen = Math.trunc(session.server.time())
    this.#lastSeen = this.firstSeen
  }

  /**
   * The principals that the code the player runs runs as, as FiveM's
   * server has them: identifier.<identifier> for each identifier, then
   * player.<net id>.
   */
  get principals(): string[] {
    return [
      ...this.identifiers.map((identifier) => `identifier.${identifier}`),
      `player.${this.netId}`,
    ]
  }

  /** When the server last heard from the client, in whole milliseconds by its clock, as it does each tick of the client. */
  get lastSeen(): number {
    return this.#lastSeen
  }

  /** Whether the server is dropping the player, or dropped it. */
  get dropping(): boolean {
    return this.#dropping
  }

  /**
   * Quits the server, as clients of FiveM do: the server drops the player
   * for `reason`, as by the client.
   */
  quit(reason = 'Exiting'): void {
    this.session.drop(this, reason, CLIENT_DROP_RESOURCE, DropReason.client)
  }

  /** @internal Called as the client ticks, which FiveM's clients send packets with. */
  touch(): void {
    this.#lastSeen = Math.trunc(this.session.server.time())
  }

  /** @internal Marks the player as being dropped, and returns whether it was already. */
  startDropping(): boolean {
    const was = this.#dropping
    this.#dropping = true
    return was
  }
}

/**
 * A server and the clients connected to it, as FiveM's network connects
 * them: what one sends another is queued for the next tick of the other, in
 * the order it was sent, as FiveM's handlers of packets queue the events
 * they get.
 */
export class Session {
  readonly server: ResourceManager
  /** The players, by their net ids, in the order they connected. */
  readonly #players = new Map<number, Player>()
  /** The net id the next player gets, unless a player has it. */
  #nextNetId = 1

  constructor(server: ResourceManager) {
    if (server.side !== 'server') throw new Error('A session needs a server')
    if (server.session !== undefined) throw new Error('The server has a session already')
    this.server = server
    server.joinSession(this)
  }

  /**
   * Connects a client to the server, which gives it a net id as FiveM's
   * gives them: the next one after the last it gave that no player has; see
   * netIdAfter.
   */
  connect(client: ResourceManager, identity: PlayerIdentity = {}): Player {
    if (client.side !== 'client') throw new Error('Only clients connect to servers')
    if (client.session !== undefined) throw new Error('The client is connected already')
    while (this.#players.has(this.#nextNetId)) this.#nextNetId = netIdAfter(this.#nextNetId)
    const player = new Player(this, client, this.#nextNetId, identity)
    this.#nextNetId = netIdAfter(this.#nextNetId)
    this.#players.set(player.netId, player)
    client.joinSession(this, player)
    return player
  }

  /** The players, in the order they connected. */
  get players(): IterableIterator<Player> {
    return this.#players.values()
  }

  /** The player with the net id `netId`, if there is one. */
  player(netId: number): Player | undefined {
    return this.#players.get(netId)
  }

  /**
   * Drops a player, as FiveM's server does: once, for `reason`, or
   * Dropped. for none, as `resource` asks it to, which it triggers
   * playerDropped with, then disconnects the client. Without OneSync, it
   * tells the other clients as FiveM's does, with onPlayerDropped.
   */
  drop(
    player: Player,
    reason: string,
    resource: string = SERVER_DROP_RESOURCE,
    cause: number = DropReason.server,
  ): void {
    if (this.#players.get(player.netId) !== player || player.startDropping()) return
    const why = reason === '' ? 'Dropped.' : reason
    const source = `internal-net:${player.netId}`
    this.server.events.trigger('playerDropped', pack([why, resource, cause]), source)
    this.#players.delete(player.netId)
    player.client.leaveSession()
    if (!this.server.oneSync) {
      const payload = pack([player.netId, player.name, -1])
      for (const { client } of this.#players.values()) {
        client.events.queue('onPlayerDropped', payload, `net:${SERVER_NET_ID}`)
      }
    }
  }

  /** Ticks the server, then the clients in the order they connected. */
  tick(): void {
    this.server.tick()
    for (const { client } of this.#players.values()) client.tick()
  }
}
