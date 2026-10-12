import {
  catalogNatives,
  defineNative,
  NativeRegistry,
  nativeWrapper,
  type NativeDefinition,
} from '../../src/core/natives/index.ts'
import {
  CLOCK_START,
  ScriptRuntime,
  type ScriptNatives,
  type StackBoundaries,
} from '../../src/core/scripting/runtime.ts'
import { createRuntime } from '../lua/helpers.ts'

export interface ResourceOptions {
  readonly name?: string
  /** Natives the scripts can call; they run with the script runtime as their context. */
  readonly natives?: readonly NativeDefinition<ScriptRuntime>[]
  /** Whether the runtime is a client's, which has Citizen.GetNative. Defaults to false. */
  readonly client?: boolean
  /** Whether the natives of the catalog come first, for `natives` to replace. Defaults to false. */
  readonly catalog?: boolean
  /** Replaces how the host formats stack traces: by default, it formats the runtime's own frames. */
  readonly formatStackTrace?: () => string
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
  /**
   * The boundaries the runtime submitted last, which the test keeps as if
   * all calls into the runtime were one that no other runtime made: stack
   * traces show the runtime's own frames between them.
   */
  readonly boundaries: StackBoundaries
  /** The time in milliseconds, which the runtime's clock counts from CLOCK_START. */
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

/**
 * Natives that FiveLab's scripts call before any resource script runs, as
 * FiveM's do: on servers, the handler of HTTP responses registers the
 * resource for their event. The test's natives can replace them.
 */
const SETUP_NATIVES: readonly NativeDefinition<ScriptRuntime>[] = [
  defineNative(
    { name: 'REGISTER_RESOURCE_AS_EVENT_HANDLER', result: 'void', params: ['char* eventName'] },
    () => {},
  ),
]

export async function createResource(options: ResourceOptions = {}): Promise<TestResource> {
  const { name = 'test', client = false } = options
  const natives = [
    ...(options.catalog ? catalogNatives<ScriptRuntime>(client ? 'client' : 'server') : []),
    ...SETUP_NATIVES,
    ...(options.natives ?? []),
  ]
  const runtime = await createRuntime()
  let time = 0
  let output = ''
  let taken = 0
  const warnings: string[] = []
  const log: string[] = []
  const diagnostics: string[] = []
  const loads: string[] = []
  const boundaries: { -readonly [K in keyof StackBoundaries]: StackBoundaries[K] } = {
    start: null,
    end: null,
  }
  const script = ScriptRuntime.create(runtime, {
    resource: name,
    instanceId: 1,
    natives: scriptNatives(natives, client, loads),
    clock: () => CLOCK_START + time * 1000,
    trace: (text) => {
      output += text
    },
    warn: (message) => warnings.push(message),
    log: (channel, text) => log.push(`[${channel}] ${text}`),
    diagnose: (message) => diagnostics.push(message),
    submitBoundary: (which, id) => {
      boundaries[which] = id
    },
    formatStackTrace:
      options.formatStackTrace ??
      (() =>
        script
          .walkStack(boundaries)
          .map(({ name, file, line }) => `^3> ${name}^7 (^5${file}^7:${line})\n`)
          .join('')),
    // Calls the references of the runtime itself, the only one, with id 1.
    invokeFunctionReference: (ref, args) => {
      const prefix = `${name}:1:`
      if (!ref.startsWith(prefix)) return undefined
      return script.callRef(Number.parseInt(ref.slice(prefix.length), 10), args)
    },
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
    boundaries,
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
