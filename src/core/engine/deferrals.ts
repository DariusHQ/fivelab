import { compareUtf8 } from '../libc.ts'
import type { ResourceManager } from './manager.ts'
import { packObject, stringOf, toJson, type Extension, type MsgpackObject } from './msgpack.ts'
import { msgpackOfJson } from './rapidjson.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** What a resource deferring a connection says until it says something else, as FiveM says it. */
const DEFERRING = 'Deferring connection...'

/** Why FiveM's servers refuse a player that a handler of playerConnecting canceled, unless it said why. */
const PREVENTED = 'Resource prevented connection.'

/** The state of the deferral of one resource, as FiveM's DeferralState. */
interface DeferralState {
  description: string
  message: string
  done: boolean
  rejected: boolean
}

/** What deferrals tell the connection they defer. */
export interface DeferralOutcome {
  /** Says where the deferrals are: what each resource that is not done said, a line each. */
  message(text: string): void
  /** Presents an adaptive card, as its JSON. */
  card(json: string): void
  /** Lets the player connect. */
  resolve(): void
  /** Refuses the player for `message`, as `resource` asked. */
  reject(message: string, resource: string): void
}

/** Calls of deferrals with values that FiveM fails to convert, which FiveLab ignores. */
class ConversionError extends Error {}

/** How FiveLab names the types of msgpack values. */
const KINDS: Readonly<Record<MsgpackObject['type'], string>> = {
  nil: 'nil',
  boolean: 'a boolean',
  positive: 'an integer',
  negative: 'an integer',
  float32: 'a float',
  float64: 'a float',
  str: 'a string',
  bin: 'a binary',
  array: 'an array',
  map: 'a map',
  ext: 'an extension',
}

/**
 * The deferrals of a connecting player, as FiveM's ClientDeferral keeps
 * them: each resource that defers the connection, or updates, presents a
 * card for or ends its deferral, has a state, by its name, and the
 * connection waits until all of them are done, or one of them, the first
 * by the bytes of their names, refuses it. What resources ask while
 * playerConnecting is triggered waits until the event ran.
 */
export class Deferral {
  readonly #manager: ResourceManager
  readonly #outcome: DeferralOutcome
  readonly #states = new Map<string, DeferralState>()
  readonly #handover = new Map<string, string>()
  #ranEvents = false
  #pending = false
  #completed = false
  #nextCard: string | undefined
  /** The reference to the function that the last card presented with one gives what the client submits. */
  #cardResponse: string | undefined
  #kickReason = PREVENTED

  constructor(manager: ResourceManager, outcome: DeferralOutcome) {
    this.#manager = manager
    this.#outcome = outcome
  }

  /** Whether a resource deferred the connection, or said anything of it. */
  get deferred(): boolean {
    return this.#states.size > 0
  }

  /** Whether the deferrals resolved or refused the connection, or the server ended them, after which they do nothing. */
  get completed(): boolean {
    return this.#completed
  }

  /** Ends the deferrals, as FiveM's server does with those of players it refuses, lets connect or drops. */
  cancel(): void {
    this.#complete()
  }

  /**
   * Gives the function of the card last presented with one what the client
   * submitted of it, as FiveM's server does at its next tick: the JSON as
   * msgpack, as RapidJSON reads it, then the JSON. Nothing gets JSON that
   * RapidJSON fails to read, nor what comes once the deferrals ended.
   */
  respondToCard(json: string): void {
    const ref = this.#cardResponse
    if (ref === undefined) return
    const bytes = encoder.encode(json)
    this.#manager.enqueue(() => {
      const data = msgpackOfJson(bytes)
      if (data === undefined) return
      const args = packObject({ type: 'array', items: [data, { type: 'str', bytes }] })
      this.#manager.invokeFunctionReference(ref, args)
    })
  }

  /** The data that handover gave the player to have as it connects, as JSON, by key in the order of their bytes. */
  get handover(): ReadonlyMap<string, string> {
    return new Map([...this.#handover].sort(([a], [b]) => compareUtf8(a, b)))
  }

  /**
   * The functions that playerConnecting gives scripts to defer the
   * connection with, as references to callbacks: defer, update,
   * presentCard, done and handover, which the deferral of the resource that
   * calls them takes. They do nothing once the deferrals completed, nor for
   * calls from no resource.
   */
  callbacks(): Record<string, Extension> {
    const create = (name: string, fn: (resource: string, args: readonly MsgpackObject[]) => void) =>
      this.#manager.callbacks.create((args) => {
        const resource = this.#manager.currentResource?.name
        if (this.#completed || resource === undefined) return
        try {
          if (args.type !== 'array')
            throw new ConversionError(
              'arguments that are no array, which msgpack fails to convert to a vector',
            )
          fn(resource, args.items)
        } catch (error) {
          if (!(error instanceof ConversionError)) throw error
          this.#diagnose(`deferrals.${name}`, resource, error)
        }
      })
    return {
      defer: create('defer', (resource) => {
        this.#states.set(resource, {
          description: resource,
          message: DEFERRING,
          done: false,
          rejected: false,
        })
        this.#update()
      }),
      update: create('update', (resource, args) => {
        const state = this.#state(resource)
        if (args.length !== 1) return
        state.message = stringArgument(args[0]!)
        this.#update()
      }),
      presentCard: create('presentCard', (resource, args) => {
        this.#state(resource)
        const card = args[0]
        if (card === undefined) return
        const json = card.type === 'str' || card.type === 'bin' ? stringOf(card)! : jsonOf(card)
        if (json !== undefined) this.#presentCard(json)
        // FiveM keeps the function that comes as a reference, of scripts or of its own code.
        const callback = args[1]
        if (callback?.type === 'ext' && [10, 11].includes(callback.extension.type)) {
          this.#respondWith(decoder.decode(callback.extension.data))
        }
      }),
      done: create('done', (resource, args) => {
        const state = this.#state(resource)
        state.done = true
        if (args.length === 1) {
          const reason = args[0]!
          state.message = reason.type === 'str' ? stringOf(reason)! : 'Unknown error'
          state.rejected = true
        }
        this.#update()
      }),
      handover: create('handover', (_resource, args) => {
        try {
          for (const [key, value] of stringMapOf(args[0])) {
            const json = toJson(value)
            if (json !== undefined) this.#handover.set(key, json)
          }
        } catch (error) {
          // FiveM gives up on what does not convert, and keeps what did.
          if (!(error instanceof TypeError)) throw error
        }
      }),
    }
  }

  /** Why the server refuses the player if a handler of playerConnecting canceled it. */
  get kickReason(): string {
    return this.#kickReason
  }

  /**
   * The function that playerConnecting gives scripts to say why the handler
   * that cancels the event refuses the player, as a reference to a
   * callback, which keeps the last reason it is given.
   */
  kickReasonCallback(): Extension {
    return this.#manager.callbacks.create((args) => {
      try {
        if (args.type !== 'array')
          throw new ConversionError(
            'arguments that are no array, which msgpack fails to convert to a vector',
          )
        if (args.items.length === 1) this.#kickReason = stringArgument(args.items[0]!)
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error
        this.#diagnose('setKickReason', this.#manager.currentResource?.name ?? '', error)
      }
    })
  }

  /** Called once playerConnecting ran, which lets what resources asked meanwhile happen. */
  ranEvents(): void {
    this.#ranEvents = true
    if (this.#pending) this.#update()
    if (this.#nextCard !== undefined) this.#presentCard(this.#nextCard)
  }

  /** Says that a script gave a function of the connection what FiveM fails to convert. */
  #diagnose(name: string, resource: string, error: ConversionError): void {
    this.#manager.output.diagnose(
      resource,
      `${name} was given ${error.message}: msgpack throws then, which FiveLab does not emulate, and it ignores the call.`,
    )
  }

  /** The state of the deferral of a resource, which it gets as FiveM's std::map gives one. */
  #state(resource: string): DeferralState {
    let state = this.#states.get(resource)
    if (state === undefined) {
      state = { description: '', message: '', done: false, rejected: false }
      this.#states.set(resource, state)
    }
    return state
  }

  /**
   * Keeps the function that a reference names for what the client submits
   * of cards, as FiveM's FunctionRef does: as a holder of the function, in
   * place of the one before.
   */
  #respondWith(ref: string): void {
    this.#manager.duplicateFunctionReference(ref)
    const old = this.#cardResponse
    this.#cardResponse = ref
    if (old !== undefined) this.#manager.deleteFunctionReference(old)
  }

  /** Ends the deferrals, which let go of the function for cards, as FiveM's server lets go of deferrals that ended. */
  #complete(): void {
    this.#completed = true
    const ref = this.#cardResponse
    this.#cardResponse = undefined
    if (ref !== undefined) this.#manager.deleteFunctionReference(ref)
  }

  /** Presents a card, once playerConnecting ran, unless the deferrals completed, which ends what they say. */
  #presentCard(json: string): void {
    if (!this.#ranEvents) this.#nextCard = json
    else if (!this.#completed) this.#outcome.card(json)
  }

  /** Tells the connection where its deferrals are, as FiveM's UpdateDeferrals does. */
  #update(): void {
    if (!this.#ranEvents) {
      this.#pending = true
      return
    }
    let allDone = true
    let progress = ''
    for (const [resource, state] of [...this.#states].sort(([a], [b]) => compareUtf8(a, b))) {
      if (!state.done) {
        progress += `${state.description}: ${state.message}\n`
        allDone = false
      }
      if (state.rejected) {
        this.#complete()
        this.#outcome.reject(state.message, resource)
        return
      }
    }
    if (allDone) {
      this.#complete()
      this.#outcome.resolve()
      return
    }
    this.#outcome.message(progress)
  }
}

/** The string an argument converts to, as msgpack-c converts str and bin, which fails for others. */
export function stringArgument(object: MsgpackObject): string {
  const text = stringOf(object)
  if (text === undefined) {
    throw new ConversionError(`${KINDS[object.type]}, which msgpack fails to convert to a string`)
  }
  return text
}

/** The JSON of a card, as FiveM converts it, which fails for maps with keys of more than one type. */
function jsonOf(card: MsgpackObject): string | undefined {
  try {
    return toJson(card)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new ConversionError(
      'a card with a map whose keys are not all of the type of its first, which FiveM fails to convert to JSON',
    )
  }
}

/**
 * The entries of a map of strings, as msgpack-c converts a value to a
 * std::map of std::string: ordered by their keys, with the last of each.
 * Throws a TypeError for other values.
 */
function stringMapOf(object: MsgpackObject | undefined): [string, MsgpackObject][] {
  if (object?.type !== 'map') throw new TypeError('The value is no map')
  const entries = new Map<string, MsgpackObject>()
  for (const [key, value] of object.entries) {
    const name = stringOf(key)
    if (name === undefined) throw new TypeError('A key of the map is no string')
    entries.set(name, value)
  }
  return [...entries].sort(([a], [b]) => compareUtf8(a, b))
}
