import type { ConsoleContext } from './context.ts'
import type { Access } from './security.ts'
import { VariableFlags } from './variables.ts'

/**
 * Adds the variable and the commands with which FiveM's security is managed
 * from the console of its process, as FiveM adds them to its default
 * context:
 *
 * - se_debug, which makes checks print what they find;
 * - on servers, add_ace, remove_ace, add_principal and remove_principal,
 *   which change who may access what;
 * - test_ace, which says whether a principal may access an object;
 * - list_principals and list_aces, which list the inheritances and the
 *   entries.
 */
export function addAccessCommands(context: ConsoleContext): void {
  const { security, output, commands, variables } = context
  const print = (text: string) => output.print('security', text)
  variables.define('se_debug', VariableFlags.none, 'bool', false).track((on) => {
    security.debug = on === true ? output : undefined
  })
  if (context.server) {
    const change =
      (apply: (principal: string, object: string, access: Access) => void) =>
      (principal: string, object: string, access: string) => {
        if (access !== 'allow' && access !== 'deny') {
          print("Access type needs to be 'allow' or 'deny'.\n")
          return
        }
        // FiveM compares the principal as written with those that code runs as, lowercased.
        if (security.principals.includes(principal)) {
          print('Changing ones own access is not permitted.\n')
          return
        }
        apply(principal, object, access)
      }
    commands.add(
      'add_ace',
      ['string', 'string', 'string'],
      change((principal, object, access) => security.addEntry(principal, object, access)),
    )
    commands.add('add_principal', ['string', 'string'], (child, parent) =>
      security.addInheritance(child, parent),
    )
    commands.add(
      'remove_ace',
      ['string', 'string', 'string'],
      change((principal, object, access) => security.removeEntry(principal, object, access)),
    )
    commands.add('remove_principal', ['string', 'string'], (child, parent) =>
      security.removeInheritance(child, parent),
    )
  }
  commands.add('test_ace', ['string', 'string'], (principal, object) => {
    const allowed = security.checkPrincipal(principal, object)
    print(`${principal} -> ${object} = ${allowed ? 'true' : 'false'}\n`)
  })
  commands.add('list_principals', [], () => {
    for (const { child, parent } of security.inheritances) print(`${child} <- ${parent}\n`)
  })
  commands.add('list_aces', [], () => {
    for (const { principal, object, access } of security.entries) {
      print(`${principal} -> ${object} = ${access === 'allow' ? 'ALLOW' : 'DENY'}\n`)
    }
  })
}
