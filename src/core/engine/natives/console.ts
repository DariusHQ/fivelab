import { EVERYONE, type CommandInfo } from '../../console/index.ts'
import { atoi } from '../../libc.ts'
import { defineNative, type NativeDefinition } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import { INT32_MAX } from '../hook.ts'
import { pack } from '../msgpack.ts'
import { checkArgument } from './events.ts'

/** Commands as FiveM gives scripts the commands of the console: as maps of their name, resource and arity. */
function packCommands(commands: readonly CommandInfo[]): Uint8Array {
  return pack(commands.map(({ name, resource, arity }) => ({ name, resource, arity })))
}

/** Natives of the console of the process: its commands and who may access what. */
export function consoleNatives(): NativeDefinition<NativeContext>[] {
  // The functions that the commands scripts registered call, by the names
  // of the commands as written, for every runtime of the process: a script
  // that registers a command again gives its handler the new function.
  const functions = new Map<string, string>()
  return [
    defineNative(
      { name: 'EXECUTE_COMMAND', result: 'void', params: ['bytes commandString'] },
      (ctx: NativeContext, commandString) => {
        const { manager, resource } = ctx
        manager.security.runAs(`resource.${resource.name}`, () => {
          const bytes = checkArgument(commandString, 0)
          // FiveM reads the command as a C string, which ends at a NUL.
          const end = bytes.indexOf(0)
          manager.console.execute(end === -1 ? bytes : bytes.subarray(0, end))
        })
      },
    ),
    defineNative(
      {
        name: 'REGISTER_COMMAND',
        result: 'void',
        params: ['char* commandName', 'func handler', 'bool restricted'],
      },
      (ctx: NativeContext, commandName, handler, restricted) => {
        const name = checkArgument(commandName, 0)
        functions.set(name, checkArgument(handler, 1))
        const { manager, resource } = ctx
        const { console, security } = manager
        if (console.commands.has(name)) return
        // The resource may change who may run its command, and everyone may
        // run it unless it is restricted.
        const principal = `resource.${resource.name}`
        const object = `command.${name}`
        security.addEntry(principal, object, 'allow')
        if (!restricted) security.addEntry(EVERYONE, object, 'allow')
        const token = console.commands.register(name, resource.name, ({ args, source }) => {
          const call = pack([atoi(source), [...args], console.commands.rawCommand])
          manager.invokeFunctionReference(functions.get(name)!, call)
          return true
        })
        resource.onStop.connect(() => {
          console.commands.unregister(token)
          security.removeEntry(EVERYONE, object, 'allow')
          security.removeEntry(principal, object, 'allow')
        }, INT32_MAX)
      },
    ),
    defineNative(
      { name: 'GET_REGISTERED_COMMANDS', result: 'object', params: [] },
      (ctx: NativeContext) => packCommands(ctx.manager.console.commands.list),
    ),
    defineNative(
      { name: 'GET_RESOURCE_COMMANDS', result: 'object', params: ['char* resource'] },
      (ctx: NativeContext, resource) => {
        const name = checkArgument(resource, 0)
        const { manager } = ctx
        // FiveM lists the commands of the resource by the name as given,
        // when it finds a resource of that name or one that provides it.
        if (manager.getResource(name) === undefined) return packCommands([])
        return packCommands(manager.console.commands.list.filter((c) => c.resource === name))
      },
    ),
    defineNative(
      { name: 'IS_ACE_ALLOWED', result: 'BOOL', params: ['char* object'] },
      (ctx: NativeContext, object) => ctx.manager.security.check(checkArgument(object, 0)),
    ),
    defineNative(
      {
        name: 'IS_PRINCIPAL_ACE_ALLOWED',
        result: 'BOOL',
        params: ['char* principal', 'char* object'],
      },
      // FiveM checks as the principal alone, not as those the code runs as.
      (ctx: NativeContext, principal, object) => {
        const who = checkArgument(principal, 0)
        return ctx.manager.security.checkPrincipal(who, checkArgument(object, 1))
      },
    ),
  ]
}
