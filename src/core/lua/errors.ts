import { LUA_ERRERR, LUA_ERRMEM, LUA_ERRSYNTAX } from './abi.ts'

export type LuaErrorKind = 'runtime' | 'syntax' | 'memory' | 'handler'

/**
 * An error raised by Lua code. The state that raised it keeps working.
 *
 * Host functions throw it to raise a Lua error with exactly this message;
 * other exceptions they throw reach Lua as String(exception).
 */
export class LuaError extends Error {
  override readonly name = 'LuaError'
  readonly kind: LuaErrorKind
  /** Lua's stack traceback at the point of the error, when one was recorded. */
  readonly luaTraceback: string | undefined

  constructor(message: string, kind: LuaErrorKind = 'runtime', luaTraceback?: string) {
    super(message)
    this.kind = kind
    this.luaTraceback = luaTraceback
  }

  static kindOf(status: number): LuaErrorKind {
    switch (status) {
      case LUA_ERRSYNTAX:
        return 'syntax'
      case LUA_ERRMEM:
        return 'memory'
      case LUA_ERRERR:
        return 'handler'
      default:
        return 'runtime'
    }
  }
}

/**
 * Thrown by a host function for a bad argument, which Lua reports as
 * luaL_argerror does: "bad argument #n to 'name' (message)", with the
 * position of the caller, naming the function as the script called it.
 */
export class LuaArgumentError extends Error {
  override readonly name = 'LuaArgumentError'
  /** The index of the argument, from 1. */
  readonly argument: number

  constructor(argument: number, message: string) {
    super(message)
    this.argument = argument
  }
}

/**
 * Thrown by a host function to raise a Lua error as luaL_error does: with
 * the position of the Lua code that called it before the message.
 */
export class LuaCallerError extends Error {
  override readonly name = 'LuaCallerError'
}

/**
 * A Lua state, or the whole runtime hosting it, can no longer run code: Lua
 * panicked, the watchdog stopped a runaway script, or the WebAssembly module
 * trapped. Every later call fails with the same error.
 */
export class LuaFatalError extends Error {
  override readonly name = 'LuaFatalError'
  /** Whether one state died or the runtime with all of its states. */
  readonly scope: 'state' | 'runtime'

  constructor(message: string, scope: 'state' | 'runtime', options?: ErrorOptions) {
    super(message, options)
    this.scope = scope
  }
}

/** Whether `error` reports an exhausted native stack (V8 and SpiderMonkey wording). */
export function isStackOverflow(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error instanceof RangeError || error.name === 'InternalError') &&
    /call stack|too much recursion/i.test(error.message)
  )
}
