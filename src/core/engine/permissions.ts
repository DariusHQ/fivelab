import type { ResourceManager } from './manager.ts'

/**
 * Which resources may write the files of which others, as FiveM's servers
 * keep it for scripts: a resource may write those of another once
 * add_filesystem_permission gave it write, until read takes it back. Names
 * match exactly, case included.
 */
export class FilesystemPermissions {
  /** What each resource was given, by the names of the resources it was given it for. */
  readonly #given = new Map<string, Map<string, 'read' | 'write'>>()

  give(source: string, operation: 'read' | 'write', target: string): void {
    const given = this.#given.get(source)
    if (given === undefined) this.#given.set(source, new Map([[target, operation]]))
    else given.set(target, operation)
  }

  /** Whether `source` was given write for the files of `target`. */
  mayWrite(source: string, target: string): boolean {
    return this.#given.get(source)?.get(target) === 'write'
  }
}

/**
 * Adds the commands with which FiveM's servers give resources permissions
 * to the default console, as FiveM adds them: add_filesystem_permission,
 * which takes write or read, and add_unsafe_worker_permission and
 * add_unsafe_child_process_permission, for JavaScript, which FiveRunner does
 * not run. They give nothing once the server ended its initial
 * configuration, and warn about it.
 */
export function addPermissionCommands(
  manager: ResourceManager,
  permissions: FilesystemPermissions,
): void {
  const { commands } = manager.defaultConsole
  /** Whether permissions may still be given, which the command warns about when not. */
  const mayGive = (command: string) => {
    if (!manager.configured) return true
    manager.logWarning(
      'citizen-scripting-core',
      `${command} is only executable before the server finished execution.\n`,
    )
    return false
  }
  commands.add(
    'add_filesystem_permission',
    ['string', 'string', 'string'],
    (source, operation, target) => {
      if (!mayGive('add_filesystem_permission')) return
      if (operation === 'write' || operation === 'read') permissions.give(source, operation, target)
    },
  )
  commands.add('add_unsafe_worker_permission', ['string'], () => {
    mayGive('add_unsafe_worker_permission')
  })
  commands.add('add_unsafe_child_process_permission', ['string'], () => {
    mayGive('add_unsafe_child_process_permission')
  })
}
