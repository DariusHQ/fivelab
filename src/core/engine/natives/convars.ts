import { namePattern, VariableFlags } from '../../console/index.ts'
import { lowerAscii, stof, stoi } from '../../libc.ts'
import { defineNative, type NativeDefinition, type Side } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import type { ResourceManager } from '../manager.ts'
import { pack } from '../msgpack.ts'
import { checkArgument } from './events.ts'

/**
 * Whether the code that runs may read a console variable, as FiveM's
 * CanReadConVar says: on servers, whether the resource it is code of may,
 * if the variable is restricted to some.
 */
function mayRead(manager: ResourceManager, name: string): boolean {
  return manager.convarPermissions?.mayRead(name, manager.currentResource?.name) ?? true
}

/** Whether scripts may never read a console variable, which its ScriptRestricted flag says. */
function scriptRestricted(manager: ResourceManager, name: string): boolean {
  return (manager.console.variables.flagsOf(name) & VariableFlags.scriptRestricted) !== 0
}

/**
 * A console variable of the console of scripts as FiveM's GetConVar gives
 * it to them, converted, or undefined where FiveM gives the default: for
 * variables that the code that runs may not read or that the console does
 * not have, and values that do not convert.
 */
function readConvar<T>(
  ctx: NativeContext,
  varName: string | null,
  convert: (value: string) => T | undefined,
): T | undefined {
  const name = checkArgument(varName, 0)
  const { manager } = ctx
  if (scriptRestricted(manager, name)) return undefined
  const variable = manager.console.variables.find(name)
  if (variable === undefined) return undefined
  const value = convert(variable.value)
  return mayRead(manager, name) ? value : undefined
}

/** A value as FiveM reads ints from variables: in any case, true and false as 1 and 0, then as std::stoi does. */
function readInt(value: string): number | undefined {
  const lower = lowerAscii(value)
  return stoi(lower === 'true' ? '1' : lower === 'false' ? '0' : lower)
}

/** Natives of the console variables of the console of scripts. */
export function convarNatives(side: Side): NativeDefinition<NativeContext>[] {
  // The references of the functions that convar change listeners call, by
  // their cookies, which FiveM holds while they listen.
  const listeners = new Map<number, string>()
  const unlisten = (manager: ResourceManager, cookie: number) => {
    manager.console.variables.unwatch(cookie)
    const ref = listeners.get(cookie)
    if (ref === undefined) return
    listeners.delete(cookie)
    manager.deleteFunctionReference(ref)
  }
  /** Runs a command of the console of scripts as the console, as FiveM's server natives that set variables do. */
  const runAsConsole = (ctx: NativeContext, args: readonly string[]) => {
    const { security, console } = ctx.manager
    security.runAs('system.console', () => console.executeDirect(args))
  }
  const natives = [
    defineNative(
      { name: 'GET_CONVAR', result: 'char*', params: ['char* varName', 'char* default_'] },
      (ctx: NativeContext, varName, defaultValue) =>
        readConvar(ctx, varName, (value) => value) ?? defaultValue,
    ),
    defineNative(
      { name: 'GET_CONVAR_INT', result: 'int', params: ['char* varName', 'int default_'] },
      (ctx: NativeContext, varName, defaultValue) =>
        readConvar(ctx, varName, readInt) ?? defaultValue,
    ),
    defineNative(
      {
        name: 'GET_CONVAR_FLOAT',
        result: 'float',
        params: ['char* varName', 'float defaultValue'],
      },
      (ctx: NativeContext, varName, defaultValue) => readConvar(ctx, varName, stof) ?? defaultValue,
    ),
    defineNative(
      { name: 'GET_CONVAR_BOOL', result: 'BOOL', params: ['char* varName', 'bool defaultValue'] },
      (ctx: NativeContext, varName, defaultValue) =>
        readConvar(ctx, varName, (value) => {
          const int = readInt(value)
          return int === undefined ? undefined : int !== 0
        }) ?? defaultValue,
    ),
    defineNative(
      {
        name: 'ADD_CONVAR_CHANGE_LISTENER',
        result: 'int',
        params: ['char* conVarFilter', 'func handler'],
      },
      (ctx: NativeContext, conVarFilter, handler) => {
        const { manager, resource } = ctx
        const matches = namePattern(conVarFilter ?? '*')
        const ref = checkArgument(handler, 1)
        manager.duplicateFunctionReference(ref)
        // FiveM checks whether the code that changed the variable may read it.
        const cookie = manager.console.variables.watch((name) => {
          if (!mayRead(manager, name) || scriptRestricted(manager, name) || !matches(name)) return
          manager.invokeFunctionReference(ref, pack([name, '']))
        })
        listeners.set(cookie, ref)
        resource.onStop.connect(() => unlisten(manager, cookie))
        return cookie
      },
    ),
    defineNative(
      { name: 'REMOVE_CONVAR_CHANGE_LISTENER', result: 'void', params: ['int cookie'] },
      (ctx: NativeContext, cookie) => unlisten(ctx.manager, cookie),
    ),
  ]
  if (side === 'client') return natives
  const setter = (name: string, command: string) =>
    defineNative(
      { name, result: 'void', params: ['char* varName', 'char* value'] },
      (ctx: NativeContext, varName, value) =>
        runAsConsole(ctx, [command, checkArgument(varName, 0), checkArgument(value, 1)]),
    )
  return [
    ...natives,
    setter('SET_CONVAR', 'set'),
    setter('SET_CONVAR_SERVER_INFO', 'sets'),
    setter('SET_CONVAR_REPLICATED', 'setr'),
    defineNative(
      { name: 'SET_GAME_TYPE', result: 'void', params: ['char* gametypeName'] },
      (ctx: NativeContext, gametypeName) =>
        runAsConsole(ctx, ['set', 'gametype', checkArgument(gametypeName, 0)]),
    ),
    defineNative(
      { name: 'SET_MAP_NAME', result: 'void', params: ['char* mapName'] },
      (ctx: NativeContext, mapName) =>
        runAsConsole(ctx, ['set', 'mapname', checkArgument(mapName, 0)]),
    ),
    defineNative(
      { name: 'ENABLE_ENHANCED_HOST_SUPPORT', result: 'void', params: ['bool enabled'] },
      (ctx: NativeContext, enabled) =>
        runAsConsole(ctx, ['set', 'sv_enhancedHostSupport', enabled ? '1' : '0']),
    ),
  ]
}
