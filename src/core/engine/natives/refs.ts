import { defineNative, type NativeDefinition } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'

/** Says that a native was given NULL for a reference, which FiveM makes a C++ string of all the same. */
function nullReference(ctx: NativeContext, native: string, instead: string): void {
  ctx.diagnose(
    `${native} was given nil for the reference, which FiveM reads as a string all the same: its behavior is undefined, and it can crash. FiveLab ${instead}.`,
  )
}

/** Natives of function references, which name functions of runtimes for others to call. */
export function refNatives(): NativeDefinition<NativeContext>[] {
  return [
    defineNative(
      {
        name: 'DUPLICATE_FUNCTION_REFERENCE',
        result: 'char*',
        params: ['char* referenceIdentity'],
      },
      (ctx: NativeContext, ref) => {
        if (ref === null) {
          nullReference(ctx, 'DuplicateFunctionReference', 'returns nil')
          return null
        }
        const found = ctx.manager.lookUpRef(ref)
        if (found === undefined) return null
        const { resource, runtime, index } = found
        // FiveM names the runtime's resource, which may provide the name the reference has.
        const kept = resource.enter(() => runtime.duplicateRef(index))
        return `${resource.name}:${runtime.host.instanceId}:${kept}`
      },
    ),
    defineNative(
      { name: 'DELETE_FUNCTION_REFERENCE', result: 'void', params: ['char* referenceIdentity'] },
      (ctx: NativeContext, ref) => {
        if (ref === null) {
          nullReference(ctx, 'DeleteFunctionReference', 'does nothing')
          return
        }
        const found = ctx.manager.lookUpRef(ref)
        if (found === undefined) return
        const { resource, runtime, index } = found
        resource.enter(() => runtime.deleteRef(index))
      },
    ),
  ]
}
