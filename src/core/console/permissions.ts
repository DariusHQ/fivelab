import type { ConsoleContext } from './context.ts'

/**
 * Which resources may read which console variables, as FiveM's servers
 * keep it for scripts: a variable that no resource was given permission to
 * read is not restricted, and one that some resource was may be read only
 * by those resources. Names match exactly, case included.
 */
export class ConvarPermissions {
  /** The resources that may read each restricted variable, by its name. */
  readonly #readers = new Map<string, Set<string>>()

  /** Restricts a variable to the resources that may read it, which `resource` now is one of. */
  allowRead(resource: string, name: string): void {
    const readers = this.#readers.get(name)
    if (readers === undefined) this.#readers.set(name, new Set([resource]))
    else readers.add(resource)
  }

  /** Whether code of `resource`, or code of no resource, may read the variable `name`. */
  mayRead(name: string, resource: string | undefined): boolean {
    const readers = this.#readers.get(name)
    return readers === undefined || (resource !== undefined && readers.has(resource))
  }
}

/**
 * Adds FiveM's add_convar_permission command, with which servers let a
 * resource read a variable, to a console. FiveM reads no permission other
 * than read yet.
 */
export function addConvarPermissionCommands(
  context: ConsoleContext,
  permissions: ConvarPermissions,
): void {
  context.commands.add(
    'add_convar_permission',
    ['string', 'string', 'string'],
    (resource, operation, name) => {
      if (operation === 'read') permissions.allowRead(resource, name)
    },
  )
}
