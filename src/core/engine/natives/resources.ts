import { defineNative, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { checkArgument } from './events.ts'

/** The resources that FiveM's server keeps scripts from stopping: those it manages, and txAdmin's monitor. */
const MANAGED_RESOURCES = [
  'spawnmanager',
  'mapmanager',
  'baseevents',
  'chat',
  'sessionmanager',
  'monitor',
]

/** Natives about the resources of the process. */
export function resourceNatives(side: Side): NativeDefinition<NativeContext>[] {
  // The resources as GetNumResources last listed them, which
  // GetResourceByFindIndex indexes for every runtime of the process.
  let found: string[] = []
  const natives = [
    defineNative(
      { name: 'GET_RESOURCE_STATE', result: 'char*', params: ['char* resourceName'] },
      (ctx: NativeContext, resourceName) =>
        ctx.manager.getResource(checkArgument(resourceName, 0))?.state ?? 'missing',
    ),
    // FiveM lists resources in the order of its hash map of them, and
    // FiveLab in the order they were added.
    defineNative({ name: 'GET_NUM_RESOURCES', result: 'int', params: [] }, (ctx: NativeContext) => {
      found = Array.from(ctx.manager.resources, (resource) => resource.name)
      return found.length
    }),
    defineNative(
      { name: 'GET_RESOURCE_BY_FIND_INDEX', result: 'char*', params: ['int findIndex'] },
      (_ctx: NativeContext, findIndex) => found[findIndex] ?? null,
    ),
    defineNative(
      {
        name: 'GET_NUM_RESOURCE_METADATA',
        result: 'int',
        params: ['char* resourceName', 'char* metadataKey'],
      },
      (ctx: NativeContext, resourceName, metadataKey) => {
        const resource = ctx.manager.getResource(checkArgument(resourceName, 0))
        // Like FiveM, it checks the key only once it found the resource.
        return resource === undefined ? 0 : resource.entries(checkArgument(metadataKey, 1)).length
      },
    ),
    defineNative(
      {
        name: 'GET_RESOURCE_METADATA',
        result: 'char*',
        params: ['char* resourceName', 'char* metadataKey', 'int index'],
      },
      (ctx: NativeContext, resourceName, metadataKey, index) => {
        const resource = ctx.manager.getResource(checkArgument(resourceName, 0))
        if (resource === undefined) return null
        return resource.entries(checkArgument(metadataKey, 1))[index] ?? null
      },
    ),
  ]
  if (side === 'client') return natives
  return [
    ...natives,
    defineNative(
      { name: 'START_RESOURCE', result: 'BOOL', params: ['char* resourceName'] },
      (ctx: NativeContext, resourceName) =>
        ctx.manager.getResource(checkArgument(resourceName, 0))?.start() ?? false,
    ),
    defineNative(
      { name: 'STOP_RESOURCE', result: 'BOOL', params: ['char* resourceName'] },
      (ctx: NativeContext, resourceName) => {
        const resource = ctx.manager.getResource(checkArgument(resourceName, 0))
        if (resource === undefined) return false
        if (resource === ctx.manager.currentResource) {
          ctx.diagnose(
            `StopResource cannot stop ${resource.name}: FiveM keeps resources from stopping themselves.`,
          )
          return false
        }
        if (MANAGED_RESOURCES.includes(resource.name)) {
          ctx.diagnose(
            `StopResource cannot stop ${resource.name}: FiveM keeps scripts from stopping ${MANAGED_RESOURCES.join(', ')}.`,
          )
          return false
        }
        return resource.stop()
      },
    ),
  ]
}
