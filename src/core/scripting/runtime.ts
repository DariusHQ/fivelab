import { LuaError, LuaRef, type LuaRuntime, type LuaState, type LuaValue } from '../lua/index.ts'
import schedulerSource from './lua/scheduler.lua?raw'
import deferredSource from './lua/vendor/deferred.lua?raw'

/** What the scripts of one resource need from the game around them. */
export interface ScriptHost {
  /** The resource the scripts belong to. */
  readonly resource: string
  /** Milliseconds of game time, as GetGameTimer returns them. */
  gameTimer(): number
  /**
   * Writes to the resource's console: print, Citizen.Trace and script
   * errors. The text may hold FiveM colour codes (^1 and so on) and need not
   * end at a line break.
   */
  trace(text: string): void
  /** Reports a Lua warning: what warn() reports and errors in finalizers. */
  warn(message: string): void
}

/** Collects host functions into the table the FiveLab scripts receive, with their shared table. */
const HOST_TABLE = `local host = {}
for i = 1, select('#', ...), 2 do
    local name, value = select(i, ...)
    host[name] = value
end
return host, {}`

/** Reads the entry points the FiveLab scripts leave in their shared table. */
const ENTRY_POINTS = `local fivelab = ...
return fivelab.tick, fivelab.runFile`

function release(...values: LuaValue[]): void {
  for (const value of values) if (value instanceof LuaRef) value.release()
}

function functionRef(value: LuaValue): LuaRef {
  if (value instanceof LuaRef && value.type === 'function') return value
  throw new TypeError('A FiveLab script did not provide an entry point')
}

/**
 * The Lua runtime of one resource on one side, set up like FiveM's: CfxLua
 * with FiveM's libraries and require, the promise library, and the Citizen
 * scheduler with print.
 */
export class ScriptRuntime {
  readonly state: LuaState
  readonly host: ScriptHost
  readonly #tick: LuaRef
  readonly #runFile: LuaRef

  private constructor(state: LuaState, host: ScriptHost, tick: LuaRef, runFile: LuaRef) {
    this.state = state
    this.host = host
    this.#tick = tick
    this.#runFile = runFile
  }

  static create(runtime: LuaRuntime, host: ScriptHost): ScriptRuntime {
    const state = runtime.newState({ onWarning: (message) => host.warn(message) })
    try {
      state.setGlobal('require', state.requireFunction())
      state.setGlobal('dofile', null)
      state.setGlobal('loadfile', null)
      const [promise] = state.run(deferredSource, '@fivelab:/deferred.lua')
      state.setGlobal('promise', promise)
      release(promise)

      const [hostTable, fivelab] = state.run(
        HOST_TABLE,
        '=fivelab:host',
        'gameTimer',
        state.hostFunction(() => host.gameTimer()),
        'trace',
        state.hostFunction((args) => {
          host.trace(String(args.get(1)))
        }),
      )
      state.run(schedulerSource, '@fivelab:/scheduler.lua', hostTable, fivelab)
      const [tick, runFile] = state.run(ENTRY_POINTS, '=fivelab:entry', fivelab)
      release(hostTable, fivelab)
      return new ScriptRuntime(state, host, functionRef(tick), functionRef(runFile))
    } catch (error) {
      state.close()
      throw error
    }
  }

  /**
   * Loads and runs a script file of the resource as FiveM does: in its own
   * thread, so it may wait, with errors reported to the console. Returns
   * false if the file does not compile.
   */
  runFile(path: string, source: string | Uint8Array): boolean {
    const name = `@${this.host.resource}/${path}`
    let chunk: LuaRef
    try {
      chunk = this.state.load(source, `@${name}`)
    } catch (error) {
      if (!(error instanceof LuaError)) throw error
      this.host.trace(
        `Error parsing script ${name} in resource ${this.host.resource}: ${error.message}\n`,
      )
      return false
    }
    try {
      this.state.call(this.#runFile, chunk)
    } finally {
      chunk.release()
    }
    return true
  }

  /** Resumes the threads that are due at the current game time. */
  tick(): void {
    this.state.call(this.#tick)
  }

  close(): void {
    this.state.close()
  }
}
