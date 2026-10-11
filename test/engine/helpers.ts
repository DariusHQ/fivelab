import {
  ResourceManager,
  type NativeContext,
  type Resource,
  type ResourceDefinition,
} from '../../src/core/engine/index.ts'
import type { NativeDefinition, Side } from '../../src/core/natives/index.ts'
import { createRuntime } from '../lua/helpers.ts'

export interface ProcessOptions {
  readonly side?: Side
  readonly natives?: readonly NativeDefinition<NativeContext>[]
}

/** A process with a clock the test controls and its console captured line by line. */
export interface TestProcess {
  readonly manager: ResourceManager
  /** Milliseconds since the process started. */
  time: number
  readonly warnings: readonly string[]
  /** Diagnostics, as "resource: message". */
  readonly diagnostics: readonly string[]
  /**
   * Adds a resource with `files`. Without `metadata`, the resource reads its
   * fxmanifest.lua or __resource.lua, or if it has neither, its manifest
   * lists each of the files as a script of the process's side.
   */
  add(
    name: string,
    files: ResourceDefinition['files'],
    metadata?: ResourceDefinition['metadata'],
  ): Resource
  /** Moves the clock to `time` and ticks once. */
  tickAt(time: number): void
  /** The console lines written since the last call, as "[channel] text". */
  take(): string[]
}

export async function createProcess(options: ProcessOptions = {}): Promise<TestProcess> {
  const { side = 'server' } = options
  const lua = await createRuntime()
  const lines: string[] = []
  const partial = new Map<string, string>()
  const warnings: string[] = []
  const diagnostics: string[] = []
  let taken = 0
  const process: TestProcess = {
    manager: new ResourceManager({
      side,
      lua,
      time: () => process.time,
      output: {
        write: (channel, text) => {
          const pieces = ((partial.get(channel) ?? '') + text).split('\n')
          partial.set(channel, pieces.pop()!)
          for (const piece of pieces) lines.push(`[${channel}] ${piece}`)
        },
        warn: (resource, message) => warnings.push(`${resource}: ${message}`),
        diagnose: (resource, message) => diagnostics.push(`${resource}: ${message}`),
      },
      natives: options.natives ?? [],
    }),
    time: 0,
    warnings,
    diagnostics,
    add: (name, files, metadata) => {
      if (metadata === undefined && ('fxmanifest.lua' in files || '__resource.lua' in files)) {
        return process.manager.addResource(name, { files })
      }
      return process.manager.addResource(name, {
        files,
        metadata: metadata ?? Object.keys(files).map((path) => [`${side}_script`, path] as const),
      })
    },
    tickAt: (time) => {
      process.time = time
      process.manager.tick()
    },
    take: () => {
      const taking = lines.slice(taken)
      taken = lines.length
      return taking
    },
  }
  return process
}
