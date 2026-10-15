import type { NativeDefinition, Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { consoleNatives } from './console.ts'
import { convarNatives } from './convars.ts'
import { eventNatives } from './events.ts'
import { httpNatives } from './http.ts'
import { kvpNatives } from './kvp.ts'
import { networkNatives } from './network.ts'
import { playerNatives } from './players.ts'
import { refNatives } from './refs.ts'
import { resourceNatives } from './resources.ts'
import { scriptingNatives } from './scripting.ts'
import { stateBagNatives } from './states.ts'

/** The natives FiveRunner implements for a side, which replace those of the catalog. */
export function engineNatives(side: Side): NativeDefinition<NativeContext>[] {
  return [
    ...scriptingNatives(side),
    ...eventNatives(),
    ...refNatives(),
    ...resourceNatives(side),
    ...consoleNatives(side),
    ...convarNatives(side),
    ...kvpNatives(side),
    ...networkNatives(side),
    ...playerNatives(side),
    ...stateBagNatives(side),
    ...(side === 'server' ? httpNatives() : []),
  ]
}
