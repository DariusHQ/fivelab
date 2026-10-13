import type { ResourceManager } from './manager.ts'

/** The net id of what FiveM's servers send clients, which is the source of the events that clients get. */
export const SERVER_NET_ID = 0xffff

/** The net id after `id`, as FiveM's servers count them: from 1 up to 65534, then from 1 again. */
export function netIdAfter(id: number): number {
  // FiveM keeps 65535 for the server, and gives no player 0.
  return id + 1 === SERVER_NET_ID ? 1 : id + 1
}

/** A client connected to the server of a session, as FiveM's server keeps them. */
export class Player {
  readonly session: Session
  /** The process of the client. */
  readonly client: ResourceManager
  /** The id the server knows the client by, which is the source of the events it sends. */
  readonly netId: number

  /** @internal Players come from Session.connect. */
  constructor(session: Session, client: ResourceManager, netId: number) {
    this.session = session
    this.client = client
    this.netId = netId
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
  connect(client: ResourceManager): Player {
    if (client.side !== 'client') throw new Error('Only clients connect to servers')
    if (client.session !== undefined) throw new Error('The client is connected already')
    while (this.#players.has(this.#nextNetId)) this.#nextNetId = netIdAfter(this.#nextNetId)
    const player = new Player(this, client, this.#nextNetId)
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

  /** Ticks the server, then the clients in the order they connected. */
  tick(): void {
    this.server.tick()
    for (const { client } of this.#players.values()) client.tick()
  }
}
