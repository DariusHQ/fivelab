import { Deferral } from './deferrals.ts'
import type { ResourceManager } from './manager.ts'
import { ManifestError } from './manifest.ts'
import { pack } from './msgpack.ts'
import type { Resource } from './resource.ts'

/** The net id of what FiveM's servers send clients, which is the source of the events that clients get. */
export const SERVER_NET_ID = 0xffff

/** The first of the temporary net ids that FiveM's servers give the players that connect. */
export const TEMPORARY_NET_IDS = 0x10000

/** The slot that FiveM's servers with OneSync tell joining players they have. */
const ONESYNC_SLOT = 128

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
  /** The GUID the client sends: by default, the temporary net id it gets. */
  readonly guid?: string
  /** The identifiers of the player, such as license:... or ip:..., in order. None by default. */
  readonly identifiers?: readonly string[]
  /** The tokens of the client, none by default. */
  readonly tokens?: readonly string[]
  /** The IP address the client connects from, 127.0.0.1 by default. */
  readonly endpoint?: string
}

/**
 * Where a player is: connecting while handlers of playerConnecting may
 * defer it, joined once the server gave it its net id, then rejected or
 * dropped.
 */
export type PlayerState = 'connecting' | 'joined' | 'rejected' | 'dropped'

/** A client connected to the server of a session, or connecting to it, as FiveM's server keeps them. */
export class Player {
  readonly session: Session
  /** The process of the client. */
  readonly client: ResourceManager
  /** The temporary net id the player connected with, from 65536 on. */
  readonly temporaryNetId: number
  readonly name: string
  readonly guid: string
  readonly identifiers: readonly string[]
  readonly tokens: readonly string[]
  readonly endpoint: string
  /** The round-trip time to the client, in milliseconds as ENet measures it, which hosts may set. */
  ping = 0
  /** When the server first heard from the client, in whole milliseconds by its clock. */
  readonly firstSeen: number
  #netId: number
  #lastSeen: number
  #state: PlayerState = 'connecting'
  #dropping = false
  #message: string | undefined
  #card: string | undefined
  #rejection: string | undefined
  #handover: ReadonlyMap<string, string> = new Map()

  /** @internal Players come from Session.connect. */
  constructor(session: Session, client: ResourceManager, netId: number, identity: PlayerIdentity) {
    this.session = session
    this.client = client
    this.temporaryNetId = netId
    this.#netId = netId
    this.name = identity.name ?? 'player'
    this.guid = identity.guid ?? String(netId)
    this.identifiers = [...(identity.identifiers ?? [])]
    this.tokens = [...(identity.tokens ?? [])]
    this.endpoint = identity.endpoint ?? '127.0.0.1'
    this.firstSeen = Math.trunc(session.server.time())
    this.#lastSeen = this.firstSeen
  }

  /**
   * The id the server knows the player by, which is the source of the
   * events it sends: its temporary net id until it joined.
   */
  get netId(): number {
    return this.#netId
  }

  get state(): PlayerState {
    return this.#state
  }

  /** Whether the player has its net id, as FiveM's HasConnected says. */
  get connected(): boolean {
    return this.#netId < SERVER_NET_ID
  }

  /**
   * The principals that the code the player runs runs as, as FiveM's
   * server has them: identifier.<identifier> for each identifier, then
   * player.<net id>.
   */
  get principals(): string[] {
    return [
      ...this.identifiers.map((identifier) => `identifier.${identifier}`),
      `player.${this.#netId}`,
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

  /** What the deferrals of the connection last said, a line for each resource that is not done. */
  get message(): string | undefined {
    return this.#message
  }

  /** The adaptive card that the deferrals of the connection last presented, as its JSON. */
  get card(): string | undefined {
    return this.#card
  }

  /** Why the server refused the player. */
  get rejection(): string | undefined {
    return this.#rejection
  }

  /** The data that deferrals handed the player over with as it connected, as JSON, by key. */
  get handover(): ReadonlyMap<string, string> {
    return this.#handover
  }

  /**
   * Quits the server, as clients of FiveM do: the server drops the player
   * for `reason`, as by the client.
   */
  quit(reason = 'Exiting'): void {
    this.session.drop(this, reason, CLIENT_DROP_RESOURCE, DropReason.client)
  }

  /**
   * Submits the adaptive card that the deferrals of the connection last
   * presented, as clients of FiveM do, with the JSON of what its
   * Action.Submit gives.
   */
  submitCard(json: string): void {
    this.session.submitCard(this, json)
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

  /** @internal Called by the session as the connection goes on. */
  update(change: {
    readonly netId?: number
    readonly state?: PlayerState
    readonly message?: string
    readonly card?: string
    readonly rejection?: string
    readonly handover?: ReadonlyMap<string, string>
  }): void {
    this.#netId = change.netId ?? this.#netId
    this.#state = change.state ?? this.#state
    this.#message = change.message ?? this.#message
    this.#card = change.card ?? this.#card
    this.#rejection = change.rejection ?? this.#rejection
    this.#handover = change.handover ?? this.#handover
  }
}

/**
 * A server and the clients connected to it, as FiveM's network connects
 * them: what one sends another is queued for the next tick of the other, in
 * the order it was sent, as FiveM's handlers of packets queue the events
 * they get.
 *
 * Clients connect as they do to FiveM's servers: with a temporary net id,
 * from 65536 on, until the next tick of the server triggers playerConnecting
 * for them, which may refuse them, or defer their connection until the
 * deferrals it gives say whether they may connect. Players that may join at
 * the next tick of the server, which gives them their net id and triggers
 * playerJoining.
 *
 * Clients that join download the resources of the server that it gives
 * clients, as it packed them as they started, and those it starts later,
 * and stop those it stops, as FiveM's clients do. They send the server the
 * commands that they have none for, which it runs as their players.
 */
export class Session {
  readonly server: ResourceManager
  /** The players, connecting or joined, in the order they connected. */
  readonly #players: Player[] = []
  /** The players by all the net ids they had, as FiveM's server keeps them: temporary ones too. */
  readonly #byNetId = new Map<number, Player>()
  /** The net id the next player gets, unless a player has it. */
  #nextNetId = 1
  /** How many temporary net ids the server gave. */
  #temporaryNetIds = 0
  /** The deferrals of the players that connect. */
  readonly #deferrals = new Map<Player, Deferral>()
  /** The resources that each client waits to download as they started, which FiveM's clients download once. */
  readonly #starting = new Map<Player, Set<string>>()
  /** The line of the command of a client that the server runs, or empty. */
  #command = ''

  constructor(server: ResourceManager) {
    if (server.side !== 'server') throw new Error('A session needs a server')
    if (server.session !== undefined) throw new Error('The server has a session already')
    this.server = server
    server.joinSession(this)
    // FiveM's server gives scripts the commands of clients that it has none for.
    server.console.commands.onFallback.connect((_name, _args, source) => {
      if (source === '') return true
      const payload = pack([this.#command])
      return server.events.trigger(
        '__cfx_internal:commandFallback',
        payload,
        `internal-net:${source}`,
      )
    }, 99999)
  }

  /**
   * Connects a client to the server, with a temporary net id. The server
   * drops the player that has its GUID, as FiveM's does to reconnect, and
   * triggers playerConnecting for it at its next tick.
   */
  connect(client: ResourceManager, identity: PlayerIdentity = {}): Player {
    if (client.side !== 'client') throw new Error('Only clients connect to servers')
    if (client.session !== undefined) throw new Error('The client is connected already')
    const player = new Player(this, client, TEMPORARY_NET_IDS + this.#temporaryNetIds++, identity)
    const old = this.#players.find(({ guid }) => guid === player.guid)
    if (old !== undefined) {
      this.drop(old, 'Reconnecting', SERVER_DROP_RESOURCE, DropReason.clientReplaced)
    }
    this.#players.push(player)
    this.#byNetId.set(player.netId, player)
    client.joinSession(this)
    this.server.enqueue(() => this.#connecting(player))
    return player
  }

  /** The players, connecting or joined, in the order they connected. */
  get players(): IterableIterator<Player> {
    return this.#players.values()
  }

  /** The player that has, or had, the net id `netId`, while it is there, as FiveM's server finds them. */
  player(netId: number): Player | undefined {
    return this.#byNetId.get(netId)
  }

  /**
   * Drops a player, as FiveM's server does: once, for `reason`, or
   * Dropped. for none, as `resource` asks it to, which it triggers
   * playerDropped with for players that joined, then disconnects the
   * client. Without OneSync, it tells the other clients as FiveM's does,
   * with onPlayerDropped.
   */
  drop(
    player: Player,
    reason: string,
    resource: string = SERVER_DROP_RESOURCE,
    cause: number = DropReason.server,
  ): void {
    if (!this.#players.includes(player) || player.startDropping()) return
    const why = reason === '' ? 'Dropped.' : reason
    // FiveM ends the deferrals of players that it drops as they connect.
    this.#deferrals.get(player)?.cancel()
    const final = player.connected
    if (final) {
      const source = `internal-net:${player.netId}`
      this.server.events.trigger('playerDropped', pack([why, resource, cause]), source)
    }
    this.#remove(player, 'dropped')
    if (final && !this.server.oneSync) {
      const payload = pack([player.netId, player.name, -1])
      for (const { client } of this.#joined()) {
        client.events.queue('onPlayerDropped', payload, `net:${SERVER_NET_ID}`)
      }
    }
  }

  /** Ticks the server, then the clients in the order they connected. */
  tick(): void {
    this.server.tick()
    for (const { client } of [...this.#players]) client.tick()
  }

  /** The players that joined, which have their clients connected. */
  #joined(): Player[] {
    return this.#players.filter(({ state }) => state === 'joined')
  }

  /**
   * Triggers playerConnecting for a player, as FiveM's server does: with
   * its name, a function to say why a handler that cancels the event
   * refuses the player, and its deferrals.
   */
  #connecting(player: Player): void {
    if (!this.#players.includes(player)) return
    const { server } = this
    const deferral: Deferral = new Deferral(server, {
      message: (message) => player.update({ message }),
      card: (card) => player.update({ card }),
      resolve: () => this.#allow(player, deferral),
      reject: (message) => this.#reject(player, message),
    })
    this.#deferrals.set(player, deferral)
    const args = pack([player.name, deferral.kickReasonCallback(), deferral.callbacks()])
    const allowed = server.events.trigger('playerConnecting', args, `internal-net:${player.netId}`)
    deferral.ranEvents()
    // Deferrals that ended as the event ran decided first.
    if (deferral.completed) return
    if (!allowed) {
      deferral.cancel()
      this.#reject(player, deferral.kickReason)
    } else if (!deferral.deferred) {
      deferral.cancel()
      this.#allow(player, deferral)
    }
  }

  /** Lets a player join at the next tick of the server, with what deferrals handed it over with. */
  #allow(player: Player, deferral: Deferral): void {
    player.update({ handover: deferral.handover })
    this.server.enqueue(() => this.#join(player))
  }

  #reject(player: Player, rejection: string): void {
    this.#remove(player, 'rejected')
    player.update({ rejection })
  }

  /**
   * Gives a player its net id, as FiveM's server does as its client
   * connects: the next one after the last it gave that no player has; see
   * netIdAfter. Then it triggers playerJoining, with the temporary net id,
   * and tells the clients with onPlayerJoining: the player alone, of
   * itself, with OneSync, and otherwise every client, of the player, and the
   * player, of every client.
   */
  #join(player: Player): void {
    if (!this.#players.includes(player)) return
    while (this.#byNetId.has(this.#nextNetId)) this.#nextNetId = netIdAfter(this.#nextNetId)
    const netId = this.#nextNetId
    this.#nextNetId = netIdAfter(netId)
    this.#byNetId.set(netId, player)
    player.update({ netId, state: 'joined' })
    player.client.joinSession(this, player)
    // The client removes its resources and downloads those of the server as it connects.
    player.client.resetResources()
    this.#starting.set(player, new Set())
    this.#download(player)
    const { events, oneSync } = this.server
    events.trigger('playerJoining', pack([String(player.temporaryNetId)]), `internal-net:${netId}`)
    if (player.dropping) return
    const source = `net:${SERVER_NET_ID}`
    const tell = (to: Player, about: Player, slot: number) => {
      if (to.state === 'joined') {
        to.client.events.queue('onPlayerJoining', pack([about.netId, about.name, slot]), source)
      }
    }
    if (oneSync) {
      tell(player, player, ONESYNC_SLOT)
      return
    }
    for (const other of this.#players) tell(other, player, -1)
    for (const other of this.#players) tell(player, other, -1)
  }

  /** Removes a player and all the net ids it had, and disconnects its client. */
  #remove(player: Player, state: PlayerState): void {
    this.#players.splice(this.#players.indexOf(player), 1)
    for (const [netId, holder] of this.#byNetId) {
      if (holder === player) this.#byNetId.delete(netId)
    }
    this.#deferrals.delete(player)
    this.#starting.delete(player)
    const joined = player.state === 'joined'
    player.update({ state })
    player.client.leaveSession(joined)
  }

  /** @internal Called by a player that submits a card that its deferrals presented. */
  submitCard(player: Player, json: string): void {
    this.#deferrals.get(player)?.respondToCard(json)
  }

  /** @internal Called by a client that joined as it sends its server the command `line`, which the server runs at its next tick. */
  command(player: Player, line: string): void {
    this.server.enqueue(() => this.#runCommand(player, line))
  }

  /**
   * Runs a command that a client sent, as FiveM's server does: as the
   * principals of its player, for its net id. What the command prints goes
   * on forward:<net id>/<channel>, which FiveM's servers keep from their
   * console, and to the client, with __cfx_internal:serverPrint.
   */
  #runCommand(player: Player, line: string): void {
    const { server } = this
    let printed = ''
    server.printer.within(
      (channel) => `forward:${player.netId}/${channel}`,
      (text) => {
        printed += text
      },
      () =>
        server.security.runAs(player.principals, () => {
          this.#command = line
          try {
            server.console.commands.invoke(line, String(player.netId))
          } finally {
            this.#command = ''
          }
        }),
    )
    if (printed !== '' && player.state === 'joined') {
      const source = `net:${SERVER_NET_ID}`
      player.client.events.queue('__cfx_internal:serverPrint', pack([printed]), source)
    }
  }

  /** @internal Called by the server as it starts a resource that clients get, which they download and start. */
  resourceStarted(name: string): void {
    for (const player of this.#joined()) {
      const starting = this.#starting.get(player)!
      if (starting.has(name)) continue
      starting.add(name)
      this.#download(player, name)
    }
  }

  /** @internal Called by the server as it stops a resource that clients get, which they stop. */
  resourceStopped(name: string): void {
    for (const player of this.#joined()) {
      const { client } = player
      client.enqueue(() => {
        // Clients handle what their server sent before they left, but not once they connected again.
        if (client.session !== undefined && client.player !== player) return
        const resource = client.getResource(name)
        if (resource === undefined) {
          client.trace(
            'citizen-legacy-net-resources',
            `Server requested resource ${name} to be stopped, but we don't know that resource\n`,
          )
          return
        }
        resource.stop()
      })
    }
  }

  /**
   * Downloads the resources of the server for a client, as FiveM's clients
   * do: at their next tick, all that the server gives clients, or the one
   * named `only`, which they name on the console, each in place of the
   * resource of its name or of one that provides it, which they start at
   * the tick after.
   */
  #download(player: Player, only?: string): void {
    const { client } = player
    client.enqueue(() => {
      if (only !== undefined) this.#starting.get(player)?.delete(only)
      if (player.state !== 'joined') return
      const resources = this.server
        .resourcesForClients()
        .filter(({ name }) => only === undefined || name === only)
      const names = resources.map(({ name }) => `${name} `).join('')
      client.trace('citizen-legacy-net-resources', `Required resources: ${names}\n`)
      const added: Resource[] = []
      let failed: { readonly name: string; readonly error: ManifestError } | undefined
      for (const resource of resources) {
        const old = client.getResource(resource.name)
        if (old !== undefined) client.removeResource(old)
        // FiveM's client puts it in place of the resource of its name, which one that provides the name may hide.
        const named = client.getResource(resource.name, false)
        if (named !== undefined) client.removeResource(named)
        try {
          // Clients of FiveM get no files of a resource that its server did not pack yet, and fail to load it.
          added.push(client.addResource(resource.name, resource.packedForClients ?? { files: {} }))
        } catch (error) {
          if (!(error instanceof ManifestError)) throw error
          failed ??= { name: resource.name, error }
        }
      }
      if (failed !== undefined) {
        client.output.diagnose(
          failed.name,
          `FiveM's client would stop with the error "Couldn't load resource ${failed.name}: ${failed.error.message}", and start none of the resources it downloaded. FiveLab starts none of them, but goes on.`,
        )
        return
      }
      client.enqueue(() => {
        for (const resource of added) {
          // The client may have removed it meanwhile, as it downloaded it again or reset its resources.
          if (client.getResource(resource.name, false) !== resource) continue
          if (resource.start()) continue
          client.output.diagnose(
            resource.name,
            `FiveM's client would stop with the error "Couldn't start resource ${resource.name}.", which FiveLab does not emulate: it goes on.`,
          )
        }
      })
    })
  }
}
