import type { LuaRuntime, LuaValue } from '../lua/index.ts'
import type { NativeCaller } from '../natives/index.ts'
import type { ScriptRuntime } from '../scripting/runtime.ts'
import type { ResourceManager } from './manager.ts'
import type { Resource } from './resource.ts'

/**
 * What FiveLab's natives run with: the script runtime that called them, the
 * resource it belongs to and the process around them.
 */
export class NativeContext implements NativeCaller {
  readonly runtime: ScriptRuntime
  readonly resource: Resource

  constructor(runtime: ScriptRuntime, resource: Resource) {
    this.runtime = runtime
    this.resource = resource
  }

  get manager(): ResourceManager {
    return this.resource.manager
  }

  get lua(): LuaRuntime {
    return this.runtime.lua
  }

  deserialize(bytes: Uint8Array): LuaValue {
    return this.runtime.deserialize(bytes)
  }

  trace(text: string): void {
    this.runtime.trace(text)
  }

  diagnose(message: string): void {
    this.runtime.diagnose(message)
  }

  unimplemented(name: string, hash: bigint): void {
    this.runtime.unimplemented(name, hash)
  }
}
