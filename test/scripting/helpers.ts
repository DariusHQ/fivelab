import {
  NativeRegistry,
  nativeWrapper,
  type NativeDefinition,
} from '../../src/core/natives/index.ts'
import { ScriptRuntime, type ScriptNatives } from '../../src/core/scripting/runtime.ts'
import { createRuntime } from '../lua/helpers.ts'

export interface ResourceOptions {
  readonly name?: string
  /** Natives the scripts can call; they run with the script runtime as their context. */
  readonly natives?: readonly NativeDefinition<ScriptRuntime>[]
  /** Whether the runtime is a client's, which has Citizen.GetNative. Defaults to false. */
  readonly client?: boolean
}

/** A resource runtime with a game clock the test controls and its console captured. */
export interface TestResource {
  readonly script: ScriptRuntime
  /** Everything the resource wrote to its console. */
  readonly output: string
  readonly warnings: readonly string[]
  /** What was written outside of the resource, as "[channel] text". */
  readonly log: readonly string[]
  readonly diagnostics: readonly string[]
  /** The names Citizen.LoadNative was asked for. */
  readonly loads: readonly string[]
  /** The game time in milliseconds. */
  readonly time: number
  /** Runs a script file of the resource. */
  run(source: string, path?: string): boolean
  /** Moves the clock to `time` and ticks once. */
  tickAt(time: number): void
  /** Ticks `count` times, `step` milliseconds apart. */
  frames(count: number, step?: number): void
  /** Returns the console output since the last call and clears it. */
  take(): string
}

/** Natives for a script runtime, from a registry, as the engine provides them. */
export function scriptNatives(
  natives: readonly NativeDefinition<ScriptRuntime>[],
  client: boolean,
  loads: string[] = [],
): ScriptNatives {
  const registry = new NativeRegistry<ScriptRuntime>()
  registry.register(...natives)
  return {
    client,
    load: (name) => {
      loads.push(name)
      const native = registry.byName(name)
      return native === undefined ? null : nativeWrapper(native, name, { direct: client })
    },
    invoke: (runtime, ptr) => registry.invoke(runtime, ptr),
  }
}

export async function createResource(options: ResourceOptions = {}): Promise<TestResource> {
  const { name = 'test', natives = [], client = false } = options
  const runtime = await createRuntime()
  let time = 0
  let output = ''
  let taken = 0
  const warnings: string[] = []
  const log: string[] = []
  const diagnostics: string[] = []
  const loads: string[] = []
  const script = ScriptRuntime.create(runtime, {
    resource: name,
    natives: scriptNatives(natives, client, loads),
    gameTimer: () => time,
    trace: (text) => {
      output += text
    },
    warn: (message) => warnings.push(message),
    log: (channel, text) => log.push(`[${channel}] ${text}`),
    diagnose: (message) => diagnostics.push(message),
  })
  const tickAt = (at: number) => {
    time = at
    script.tick()
  }
  return {
    script,
    get output() {
      return output
    },
    warnings,
    log,
    diagnostics,
    loads,
    get time() {
      return time
    },
    run: (source, path = 'client.lua') => script.runFile(path, source),
    tickAt,
    frames: (count, step = 16) => {
      for (let i = 0; i < count; i++) tickAt(time + step)
    },
    take: () => {
      const text = output.slice(taken)
      taken = output.length
      return text
    },
  }
}
