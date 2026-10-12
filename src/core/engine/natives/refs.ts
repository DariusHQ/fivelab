import { defineNative, type NativeDefinition } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'

/** Says that a native was given NULL for a reference, which FiveM makes a C++ string of all the same. */
export function nullReference(ctx: NativeContext, native: string, instead: string): void {
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
        return ctx.manager.duplicateFunctionReference(ref)
      },
    ),
    defineNative(
      { name: 'DELETE_FUNCTION_REFERENCE', result: 'void', params: ['char* referenceIdentity'] },
      (ctx: NativeContext, ref) => {
        if (ref === null) {
          nullReference(ctx, 'DeleteFunctionReference', 'does nothing')
          return
        }
        ctx.manager.deleteFunctionReference(ref)
      },
    ),
  ]
}
