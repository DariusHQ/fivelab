import { defineNative, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
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
        const data = resource === undefined ? undefined : loadFile(resource, name)
        if (data === undefined) return null
        // Bytes keep the NULs a file may have, which a string result would end at.
        return typeof data === 'string' ? new TextEncoder().encode(data) : data
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
        const target = saveTarget(ctx, resource, name)
        if (target === 'nowhere') return false
        const write = (bytes: Uint8Array) => {
          if (target !== 'elsewhere') target.resource.writeFile(target.path, bytes)
        }
        // FiveM creates the file before it checks the data.
        write(new Uint8Array(0))
        write(bytesToSave(ctx, checkArgument(data, 2), dataLength))
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
 * but finds only the files of the exact name, as Linux does.
 */
function loadFile(resource: Resource, fileName: string): string | Uint8Array | undefined {
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
 * a name with more than slashes in it, in the current resource itself,
 * unless add_filesystem_permission lets it write in the other.
 */
function mayWrite(ctx: NativeContext, resource: Resource, fileName: string): boolean {
  if (fileName.split(/[\\/]/).every((part) => part === '')) return false
  if (ctx.manager.currentResource?.name === resource.name) return true
  ctx.diagnose(
    `SaveResourceFile cannot write ${fileName} in ${resource.name}: FiveM lets resources write the files of others only with add_filesystem_permission.`,
  )
  return false
}

/** Where SaveResourceFile writes: a file of a resource, somewhere FiveLab does not keep, or nowhere. */
type SaveTarget = { readonly resource: Resource; readonly path: string } | 'elsewhere' | 'nowhere'

/**
 * Where SaveResourceFile writes `fileName` of `resource`, as FiveM does:
 * nowhere for names of directories, nor in directories that do not exist,
 * as FiveM creates none. Names may lead out of the resource, into another
 * or out of all of them, and resolve as they do for LoadResourceFile.
 */
function saveTarget(ctx: NativeContext, resource: Resource, fileName: string): SaveTarget {
  const last = fileName.split(/[\\/]/).at(-1)
  if (last === '' || last === '.' || last === '..') return 'nowhere'
  const path = normalizePath(`${normalizePath(resource.path)}/${fileName}`)
  let owner: Resource | undefined
  let ownerRoot = ''
  for (const other of ctx.manager.resources) {
    const root = normalizePath(other.path)
    // The directories of resources, and those they are in.
    if (`${root}/`.startsWith(`${path}/`)) return 'nowhere'
    if (path.startsWith(`${root}/`) && root.length > ownerRoot.length) {
      owner = other
      ownerRoot = root
    }
  }
  if (owner === undefined) {
    ctx.diagnose(
      `SaveResourceFile wrote ${fileName} of ${resource.name} outside of any resource, which FiveLab does not keep.`,
    )
    return 'elsewhere'
  }
  const relative = path.slice(ownerRoot.length + 1)
  if (owner.hasDirectory(relative)) return 'nowhere'
  const slash = relative.lastIndexOf('/')
  const directory = slash === -1 ? '' : relative.slice(0, slash)
  if (!owner.hasDirectory(directory)) {
    ctx.diagnose(
      `SaveResourceFile cannot write ${fileName} in ${resource.name}: FiveM creates no directories, and ${owner.name} has no ${directory} directory with files in it.`,
    )
    return 'nowhere'
  }
  return { resource: owner, path: relative }
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
