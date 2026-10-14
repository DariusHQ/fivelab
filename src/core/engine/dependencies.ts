import { INT32_MIN } from '../hook.ts'
import { compareUtf8 } from '../libc.ts'
import type { ResourceManager } from './manager.ts'
import type { Resource } from './resource.ts'

/**
 * Starts resources with what they depend on, and stops them with it, as
 * FiveM's dependency loader does:
 *
 * - Before a resource starts, its dependency and dependencie entries, as
 *   dependencies { ... } writes them, start the resources they name, or
 *   those that provide them. Entries that start with / are constraints,
 *   such as /server:5181, which must hold.
 * - A resource that could not start because a dependency did not starts
 *   once that dependency starts.
 * - Before a resource stops, the resources that depend on it stop, in the
 *   order of their names. Resources that depend on each other stop once,
 *   with a diagnosis, where FiveM would stop them until its stack overflows.
 */
export class Dependencies {
  readonly #manager: ResourceManager
  /** The names of the resources that depend on each, which stop when it stops. */
  readonly #dependants = new Map<string, Set<string>>()
  /** The names of the resources that each kept from starting, which start when it starts. */
  readonly #waiting = new Map<string, Set<string>>()
  /** The resources that are stopping the resources that depend on them. */
  readonly #stoppingDependants = new Set<Resource>()

  constructor(manager: ResourceManager) {
    this.#manager = manager
  }

  /** Connects to a resource's hooks at the orders of FiveM's dependency loader. */
  attach(resource: Resource): void {
    resource.onBeforeStart.connect(() => this.#beforeStart(resource), -9999)
    resource.onStart.connect(() => this.#started(resource), 9_999_999)
    resource.onStop.connect(() => this.#stopping(resource), INT32_MIN)
  }

  #beforeStart(resource: Resource): boolean {
    const errors: string[] = []
    const loaded =
      this.#load(resource, 'dependency', errors) && this.#load(resource, 'dependencie', errors)
    if (loaded && errors.length === 0) return true
    if (errors.length > 0) {
      this.#trace(`Resource '${resource.name}' can't run:\n`)
      errors.forEach((error, i) => this.#trace(`${` ${i + 1}`.padStart(3)}. ${error}\n`))
    }
    return false
  }

  /**
   * Starts the dependencies of one key. A constraint that fails adds its
   * error and the others go on, but a dependency that is missing or does
   * not start stops the rest.
   */
  #load(resource: Resource, key: string, errors: string[]): boolean {
    for (const dependency of resource.entries(key)) {
      const constraint = this.#manager.constraints.match(dependency)
      if (constraint !== 'none') {
        if (constraint !== 'pass') errors.push(constraint.error)
        continue
      }
      const other = this.#manager.getResource(dependency)
      if (other === undefined) {
        this.#trace(`Could not find dependency ${dependency} for resource ${resource.name}.\n`)
        return false
      }
      add(this.#dependants, other.name, resource.name)
      if (other.state === 'starting' || other.state === 'started') continue
      if (!other.start()) {
        this.#trace(`Could not start dependency ${dependency} for resource ${resource.name}.\n`)
        add(this.#waiting, other.name, resource.name)
        return false
      }
    }
    return true
  }

  #started(resource: Resource): void {
    for (const name of sorted(this.#waiting.get(resource.name))) {
      this.#manager.getResource(name)?.start()
    }
    this.#waiting.delete(resource.name)
  }

  #stopping(resource: Resource): void {
    this.#stoppingDependants.add(resource)
    try {
      for (const name of sorted(this.#dependants.get(resource.name))) {
        const dependant = this.#manager.getResource(name)
        if (dependant === undefined || dependant.name === resource.name) continue
        if (this.#stoppingDependants.has(dependant)) {
          this.#manager.output.diagnose(
            dependant.name,
            `${dependant.name} depends on ${resource.name}, which is stopping while ${dependant.name} stops the resources that depend on it, as happens when resources depend on each other. FiveM would stop ${dependant.name} again, and so on until its stack overflows, which FiveLab does not emulate: it stops ${dependant.name} once.`,
          )
          continue
        }
        dependant.stop()
      }
    } finally {
      this.#stoppingDependants.delete(resource)
    }
    this.#dependants.delete(resource.name)
  }

  #trace(text: string): void {
    this.#manager.trace('citizen-resources-core', text)
  }
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key)
  if (values === undefined) map.set(key, new Set([value]))
  else values.add(value)
}

/** The names in the order FiveM goes through them, from a std::set. */
function sorted(names: Set<string> | undefined): string[] {
  return [...(names ?? [])].sort(compareUtf8)
}
