import { readFileSync } from 'node:fs'

import { LuaRuntime, type LuaRuntimeOptions } from '../../src/core/lua/index.ts'

let compiled: Promise<WebAssembly.Module> | undefined

/** cfxlua.wasm, compiled once per test file. */
export function cfxlua(): Promise<WebAssembly.Module> {
  compiled ??= WebAssembly.compile(
    readFileSync(new URL('../../src/core/lua/cfxlua.wasm', import.meta.url)),
  )
  return compiled
}

export async function createRuntime(options: LuaRuntimeOptions = {}): Promise<LuaRuntime> {
  return LuaRuntime.create(await cfxlua(), { output: () => {}, ...options })
}

/** Runs `fn` and returns what it throws, failing if it returns. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected the function to throw')
}
