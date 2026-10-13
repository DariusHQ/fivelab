import { VariableFlags, type Variable } from '../console/index.ts'
import type { ResourceManager } from './manager.ts'
import { isFxVersionAtLeast, isManifestVersionAtLeast, ManifestError } from './manifest.ts'
import { pack } from './msgpack.ts'
import { isCategory } from './resource.ts'

/** The directory that FiveM's server finds resources in, relative to the one it runs in. */
const RESOURCES = 'resources'

/** The first manifest version of __resource.lua that FiveM's server takes as up to date. */
const UP_TO_DATE_MANIFEST = '44febabe-d386-4d18-afbe-5e627f4af937'

/** What a scan says of a resource, as FiveM's ScanMessage. */
interface ScanMessage {
  readonly type: 'warning' | 'error'
  readonly resource: string
  readonly text: string
}

/** What a scan found, as FiveM's ScanResult counts it. */
interface ScanResult {
  newResources: number
  updatedResources: number
  reloadedResources: number
  readonly messages: ScanMessage[]
}

/**
 * Finds the resources of a server in its resources directory, as FiveM's
 * server scans it as it starts and when its refresh command runs.
 */
export class ResourceScanner {
  readonly #manager: ResourceManager
  /** Where the scans found each resource, by its name. */
  readonly #paths = new Map<string, string>()
  /** resources_useSystemChat, which FiveM's server adds as it first scans. */
  #useSystemChat: Variable | undefined

  constructor(manager: ResourceManager) {
    this.#manager = manager
  }

  /**
   * Scans for resources as FiveM's server does, and says what it found on
   * the console:
   *
   * - Directories in brackets are categories, which it looks in once it
   *   looked in the directory they are in, and the others are resources by
   *   their names, but for those that start with a dot and txAdmin's.
   * - It adds the resources that are new, which load their manifest, and
   *   reads the manifests of the others again. Those found elsewhere than
   *   before it stops and adds again.
   * - It warns about resources in more than one place, of which it takes
   *   the first, about categories with a manifest, and about resources that
   *   changed and have an outdated __resource.lua with client scripts.
   *
   * It triggers onResourceListRefresh after.
   */
  scan(): void {
    const manager = this.#manager
    manager.log('resources', '^2Scanning resources.^7\n')
    const result: ScanResult = {
      newResources: 0,
      updatedResources: 0,
      reloadedResources: 0,
      messages: [],
    }
    // FiveM scans its system resources too, which FiveLab has none of.
    this.#scanDirectory(RESOURCES, result)
    let errors = 0
    let warnings = 0
    for (const { type, resource, text } of result.messages) {
      const channel = `resources:${resource}`
      if (type === 'error') {
        errors++
        manager.logError(channel, `${text}\n`)
      } else {
        warnings++
        manager.logWarning(channel, `${text}\n`)
      }
    }
    const { newResources, updatedResources, reloadedResources } = result
    manager.log(
      'resources',
      reloadedResources > 0
        ? `^2Found ${newResources} new resources, and refreshed ${updatedResources}/${reloadedResources} resources.^7\n`
        : `^2Found ${newResources} resources.^7\n`,
    )
    const counted = (count: number, one: string, more: string) =>
      `${count} ${count === 1 ? one : more}`
    if (errors > 0 && warnings > 0) {
      const encountered = `${counted(warnings, 'warning', 'warnings')} and ${counted(errors, 'error', 'errors')}`
      manager.log('resources', `^1${encountered} were encountered.^7\n`)
    } else if (errors > 0) {
      manager.log('resources', `^1${counted(errors, 'error was', 'errors were')} encountered.^7\n`)
    } else if (warnings > 0) {
      manager.log(
        'resources',
        `^3${counted(warnings, 'warning was', 'warnings were')} encountered.^7\n`,
      )
    }
    manager.events.trigger('onResourceListRefresh', pack([]))
  }

  /** Scans the directory at `root` and the categories in it, as FiveM's ServerResourceList does. */
  #scanDirectory(root: string, result: ScanResult): void {
    const manager = this.#manager
    const { files, output } = manager
    this.#useSystemChat ??= manager.console.variables.define(
      'resources_useSystemChat',
      VariableFlags.none,
      'bool',
      true,
    )
    const warn = (resource: string, text: string) =>
      result.messages.push({ type: 'warning', resource, text })
    /** The resources this scan found, by their names, with where. */
    const found = new Map<string, string>()
    const changed = new Set<string>()
    const directories = [root]
    for (
      let directory = directories.shift();
      directory !== undefined;
      directory = directories.shift()
    ) {
      for (const { name, directory: isDirectory } of files.list(directory) ?? []) {
        if (!isDirectory) continue
        const path = `${directory}/${name}`
        if (isCategory(name)) {
          directories.push(path)
          const manifest = (file: string) =>
            files.read(`${path}/${file}`) !== undefined ||
            files.list(`${path}/${file}`) !== undefined
          if (manifest('fxmanifest.lua') || manifest('__resource.lua')) {
            warn(
              name.slice(1, -1),
              `${name} is a category, but has a resource manifest (if this is meant to be a resource, don't use [] around the name)`,
            )
          }
          continue
        }
        const first = found.get(name)
        if (first !== undefined) {
          warn(
            name,
            `${name} exists in more than one place (${first} is used, the duplicate is ${path})`,
          )
          continue
        }
        // Hidden directories, and so . and .., and txAdmin's are no resources.
        if (name.startsWith('.') || name.toLowerCase() === 'txadmin') continue
        // FiveM takes these from its system resources.
        if (
          name === 'yarn' ||
          name === 'webpack' ||
          (name === 'chat' && this.#useSystemChat.rawValue)
        ) {
          const instead = name === 'chat' ? ', unless resources_useSystemChat is false' : ''
          output.diagnose(
            name,
            `FiveM's server leaves out ${path}: it has its own ${name} among its system resources, which it takes instead${instead}. FiveLab has no system resources.`,
          )
          continue
        }
        found.set(name, path)
        let resource = manager.getResource(name, false)
        if (resource !== undefined && (this.#paths.get(name) ?? path) !== path) {
          resource.stop()
          manager.removeResource(resource)
          resource = undefined
        }
        if (resource !== undefined) {
          if (resource.reloadMetadata(path)) {
            changed.add(name)
            result.updatedResources++
          }
          result.reloadedResources++
          continue
        }
        manager.printer.printDeveloper('resources', `Found new resource ${name} in ${path}\n`)
        result.newResources++
        changed.add(name)
        this.#paths.set(name, path)
        try {
          manager.addResource(name, { path })
        } catch (error) {
          if (!(error instanceof ManifestError)) throw error
          if (error.missing) {
            warn(name, `${name} does not have a resource manifest (fxmanifest.lua)`)
          } else {
            result.messages.push({
              type: 'error',
              resource: name,
              text: `${name} failed to load: ${error.message}`,
            })
          }
        }
      }
    }
    for (const resource of manager.resources) {
      const { metadata, name } = resource
      if (isFxVersionAtLeast(metadata, 'adamant')) continue
      if (isManifestVersionAtLeast(metadata, UP_TO_DATE_MANIFEST)) continue
      if (changed.has(name) && resource.globEntries('client_script').length > 0) {
        warn(name, `${name} has an outdated manifest (__resource.lua instead of fxmanifest.lua)`)
      }
    }
  }
}
