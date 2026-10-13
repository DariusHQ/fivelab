import type { ResourceManager } from './manager.ts'
import { isCategory } from './resource.ts'

/** The channel of FiveM's server component, on which its commands trace what they print. */
const CHANNEL = 'citizen-server-impl'

/**
 * Adds the commands that start and stop the resources of a server to its
 * console, as FiveM's server adds them to the console of its instance:
 *
 * - start and stop take the name of a resource, or of one that it
 *   provides, or that of a category, for the resources in it in the order
 *   of their names. Empty names do nothing.
 * - restart stops and starts a resource that is started.
 * - ensure starts a resource, or the resources of a category until one it
 *   does not find, and restarts those that are started once the server
 *   ended its initial configuration.
 * - refresh scans the resources directory for resources; see
 *   ResourceManager.scanResources.
 *
 * restart and ensure run start and stop as commands of their own, which the
 * code that runs them must be allowed to run too.
 */
export function addResourceCommands(manager: ResourceManager): void {
  const { commands } = manager.console
  const trace = (text: string) => manager.trace(CHANNEL, text)
  const run = (command: string, name: string) => manager.console.executeDirect([command, name])
  const find = (name: string) => {
    const resource = manager.getResource(name)
    if (resource === undefined) trace(`^3Couldn't find resource ${name}.^7\n`)
    return resource
  }
  /** The names of the resources in a category, which FiveM takes before it runs a command for any. */
  const inCategory = (category: string) => {
    const names = manager.resourcesInCategory(category)
    if (names.length === 0) trace(`^3Couldn't find resource category ${category}.^7\n`)
    return names
  }
  commands.add('start', ['string'], (name) => {
    if (name === '') return
    if (isCategory(name)) {
      for (const resource of inCategory(name)) run('start', resource)
      return
    }
    const resource = find(name)
    // A resource that its hooks started again counts as started.
    if (resource !== undefined && !resource.start() && resource.state === 'stopped') {
      trace(`^3Couldn't start resource ${name}.^7\n`)
    }
  })
  commands.add('stop', ['string'], (name) => {
    if (name === '') return
    if (isCategory(name)) {
      for (const resource of inCategory(name)) run('stop', resource)
      return
    }
    const resource = find(name)
    if (resource !== undefined && !resource.stop() && resource.state !== 'stopped') {
      trace(`^3Couldn't stop resource ${name}.^7\n`)
    }
  })
  commands.add('restart', ['string'], (name) => {
    const resource = find(name)
    if (resource === undefined) return
    if (resource.state !== 'started') {
      trace("Can't restart a stopped resource.\n")
      return
    }
    run('stop', name)
    run('start', name)
  })
  /** Ensures a resource, and returns whether there is one of the name. */
  const ensure = (name: string) => {
    const resource = find(name)
    if (resource === undefined) return false
    // Until the server is configured, restarting a resource that others its
    // config ensured depend on would stop them for good.
    if (manager.configured && resource.state === 'started') run('stop', name)
    run('start', name)
    return true
  }
  commands.add('ensure', ['string'], (name) => {
    if (!isCategory(name)) {
      ensure(name)
      return
    }
    for (const resource of inCategory(name)) {
      if (!ensure(resource)) break
    }
  })
  commands.add('refresh', [], () => manager.scanResources())
}
