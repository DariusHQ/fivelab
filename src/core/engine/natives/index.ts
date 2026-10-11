import type { NativeDefinition, Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { scriptingNatives } from './scripting.ts'

/** The natives FiveLab implements for a side, which replace those of the catalog. */
export function engineNatives(side: Side): NativeDefinition<NativeContext>[] {
  return [...scriptingNatives(side)]
}
