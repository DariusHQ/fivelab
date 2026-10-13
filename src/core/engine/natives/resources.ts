import { defineNative, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { parentOf } from '../files.ts'
import { normalizePath } from '../glob.ts'
import type { Resource } from '../resource.ts'
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
    defineNative(
      {
        name: 'LOAD_RESOURCE_FILE',
        result: 'char*',
        params: ['char* resourceName', 'char* fileName'],
      },
      (ctx: NativeContext, resourceName, fileName) => {
        // Like FiveM, it checks the file name before the resource name.
        const name = checkArgument(fileName, 1)
        const resource = ctx.manager.getResource(checkArgument(resourceName, 0))
        // Bytes keep the NULs a file may have, which a string result would end at.
        return (resource === undefined ? undefined : loadFile(resource, name)) ?? null
      },
    ),
  ]
  if (side === 'client') return natives
  return [
    ...natives,
    defineNative(
      { name: 'GET_RESOURCE_PATH', result: 'char*', params: ['char* resourceName'] },
      (ctx: NativeContext, resourceName) =>
        ctx.manager.getResource(checkArgument(resourceName, 0))?.path ?? null,
    ),
    defineNative(
      {
        name: 'SAVE_RESOURCE_FILE',
        result: 'BOOL',
        params: ['char* resourceName', 'char* fileName', 'bytes data', 'int dataLength'],
      },
      (ctx: NativeContext, resourceName, fileName, data, dataLength) => {
        const resource = ctx.manager.getResource(checkArgument(resourceName, 0))
        if (resource === undefined) return false
        const name = checkArgument(fileName, 1)
        if (!mayWrite(ctx, resource, name)) return false
        const path = savePath(ctx, resource, name)
        const { files } = ctx.manager
        // FiveM creates the file before it checks the data.
        if (path === undefined || !files.write(path, new Uint8Array(0))) return false
        files.write(path, bytesToSave(ctx, checkArgument(data, 2), dataLength))
        return true
      },
    ),
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

/**
 * The file that LoadResourceFile reads, as FiveM finds it: names are
 * relative to the resource, after any slashes they start with, and those
 * with a drive or that lead out of the resource find nothing. Clients find
 * only the files of resources that servers sent them.
 *
 * FiveLab resolves names as FiveM does on Windows, where backslashes also
 * separate directories and .. may follow a directory that does not exist,
 * and finds the files of the name as the files of the process do: those in
 * memory only by their exact names, as Linux does.
 */
function loadFile(resource: Resource, fileName: string): Uint8Array | undefined {
  if (resource.path === '') return undefined
  // Clients read files from where FiveM mounts what servers send.
  if (resource.manager.side === 'client' && !resource.path.startsWith('resources:/')) {
    return undefined
  }
  const name = fileName.replace(/^[/\\]+/, '')
  if (/^[A-Za-z]:/.test(name)) return undefined
  const root = normalizePath(resource.path)
  const path = normalizePath(`${root}/${name}`)
  if (!path.startsWith(`${root}/`)) return undefined
  return resource.file(path.slice(root.length + 1))
}

/**
 * Whether FiveM lets the current resource write `fileName` in `resource`:
 * a name with more than slashes in it, in the current resource itself, or
 * in another that add_filesystem_permission let it write in.
 */
function mayWrite(ctx: NativeContext, resource: Resource, fileName: string): boolean {
  if (fileName.split(/[\\/]/).every((part) => part === '')) return false
  const { currentResource, filesystemPermissions } = ctx.manager
  const current = currentResource?.name ?? ''
  if (current === resource.name) return true
  if (filesystemPermissions?.mayWrite(current, resource.name)) return true
  ctx.diagnose(
    `SaveResourceFile cannot write ${fileName} in ${resource.name}: FiveM lets resources write the files of others only with add_filesystem_permission.`,
  )
  return false
}

/**
 * The path in the files of the process that SaveResourceFile writes
 * `fileName` of `resource` at, which may lead out of the resource, into
 * another or out of all of them, as it resolves for LoadResourceFile. There
 * is none for names of directories, nor in directories that are not there,
 * as FiveM creates none.
 */
function savePath(ctx: NativeContext, resource: Resource, fileName: string): string | undefined {
  const last = fileName.split(/[\\/]/).at(-1)
  if (last === '' || last === '.' || last === '..') return undefined
  const path = normalizePath(`${normalizePath(resource.path)}/${fileName}`)
  const directory = parentOf(path)
  if (ctx.manager.files.list(directory) === undefined) {
    ctx.diagnose(
      `SaveResourceFile cannot write ${fileName} in ${resource.name}: there is no directory ${directory}, and FiveM creates none.`,
    )
    return undefined
  }
  return path
}

/**
 * The bytes of `data` that SaveResourceFile writes: for a length of 0 or
 * -1, those before its first NUL, as C's strlen counts them, and otherwise
 * as many as the length says. Past the data, FiveM writes the NUL that ends
 * it, then whatever follows it in memory, which FiveLab does not emulate.
 */
function bytesToSave(ctx: NativeContext, data: Uint8Array, length: number): Uint8Array {
  if (length === 0 || length === -1) {
    const end = data.indexOf(0)
    return end === -1 ? data : data.subarray(0, end)
  }
  if (length < 0 || length > data.length + 1) {
    ctx.diagnose(
      `SaveResourceFile was told to write ${length} bytes of data that has ${data.length}. FiveM would write what follows the data in memory, which FiveLab does not emulate: it writes the data.`,
    )
    return data
  }
  if (length <= data.length) return data.subarray(0, length)
  const bytes = new Uint8Array(length)
  bytes.set(data)
  return bytes
}
