import { ScriptRuntime } from '../../src/core/scripting/runtime.ts'
import { createRuntime } from '../lua/helpers.ts'

/** A resource runtime with a game clock the test controls and its console captured. */
export interface TestResource {
  readonly script: ScriptRuntime
  /** Everything the resource wrote to its console. */
  readonly output: string
  readonly warnings: readonly string[]
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

export async function createResource(name = 'test'): Promise<TestResource> {
  const runtime = await createRuntime()
  let time = 0
  let output = ''
  let taken = 0
  const warnings: string[] = []
  const script = ScriptRuntime.create(runtime, {
    resource: name,
    gameTimer: () => time,
    trace: (text) => {
      output += text
    },
    warn: (message) => warnings.push(message),
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
