import type { LuaVector } from '../lua/index.ts'

/**
 * Types of native parameters and results, named as in FiveM's native
 * declarations (codegen_types.lua). All of these are 32-bit integers.
 */
export const INT_TYPES = [
  'Any',
  'int',
  'uint',
  'Hash',
  'Void',
  'Entity',
  'Player',
  'Ped',
  'Vehicle',
  'Object',
  'Train',
  'Cam',
  'Camera',
  'Blip',
  'Pickup',
  'Weapon',
  'Interior',
  'Group',
  'FireId',
  'CarGenerator',
  'DecisionMaker',
  'Texture',
  'TextureDict',
  'CoverPoint',
  'TaskSequence',
  'ColourIndex',
  'Sphere',
  'ScrHandle',
] as const

export type IntType = (typeof INT_TYPES)[number]

/** Types a parameter or a result can have by value. */
export type ValueType =
  IntType | 'long' | 'float' | 'BOOL' | 'bool' | 'char*' | 'Vector3' | 'func' | 'object'

/** Out-parameters: pointers to a value the native may read and write. */
export type PointerType = `${IntType | 'long' | 'float' | 'BOOL' | 'bool' | 'Vector3'}*`

/**
 * 'buffer' is FiveLab's name for a char* parameter that FiveM reads as a
 * buffer whose length is the next argument, such as an event payload, and
 * 'bytes' for one that a native reads as bytes rather than as text: all
 * those of the string the script passed, NULs included.
 */
export type ParamType = ValueType | PointerType | 'buffer' | 'bytes'

/** 'Any*' results are pointers, which FiveM reads as 64-bit integers. */
export type ResultType = ValueType | 'Any*' | 'void'

/**
 * How values of a type travel through a call's 64-bit slots: integers in
 * their low 32 bits, longs in all 64, floats as 32-bit float bits, booleans
 * as integers, strings, their bytes and function references as pointers to
 * C strings, vectors as three float slots and objects as a pointer and a
 * length.
 */
export type NativeKind =
  'int' | 'long' | 'float' | 'bool' | 'string' | 'buffer' | 'bytes' | 'vector3' | 'func' | 'object'

export interface TypeInfo {
  /** The type as declared, such as 'Entity', 'float*' or 'char*'. */
  readonly name: string
  readonly kind: NativeKind
  /** For pointers, the kind is that of the value pointed to. */
  readonly pointer: boolean
  /** Integer types that hold unsigned values (Hash, uint). */
  readonly unsigned: boolean
}

const INT_TYPE_SET: ReadonlySet<string> = new Set(INT_TYPES)

function kindOf(base: string): NativeKind | undefined {
  if (INT_TYPE_SET.has(base)) return 'int'
  switch (base) {
    case 'long':
      return 'long'
    case 'float':
      return 'float'
    case 'BOOL':
    case 'bool':
      return 'bool'
    case 'Vector3':
      return 'vector3'
    case 'func':
      return 'func'
    case 'object':
      return 'object'
    default:
      return undefined
  }
}

/** Parses a parameter or result type such as 'Entity', 'float*' or 'char*'. */
export function typeInfo(name: string): TypeInfo {
  if (name === 'char*') return { name, kind: 'string', pointer: false, unsigned: false }
  if (name === 'buffer') return { name, kind: 'buffer', pointer: false, unsigned: false }
  if (name === 'bytes') return { name, kind: 'bytes', pointer: false, unsigned: false }
  const pointer = name.endsWith('*')
  const base = pointer ? name.slice(0, -1) : name
  const kind = kindOf(base)
  if (kind === undefined || (pointer && (kind === 'func' || kind === 'object'))) {
    throw new TypeError(`Unknown native type: ${name}`)
  }
  return { name, kind, pointer, unsigned: base === 'Hash' || base === 'uint' }
}

/** A value with x, y and z, such as a LuaVector. */
export interface Vector3Like {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** An out-parameter of a native: the value it points to, which the native can read and write. */
export interface NativePointer<T> {
  /** False for a NULL pointer, which reads as zero and ignores writes. */
  readonly valid: boolean
  get(): T
  set(value: T): void
}

type PointeeValue<B extends string> = B extends 'Vector3'
  ? LuaVector
  : B extends 'BOOL' | 'bool'
    ? boolean
    : B extends 'long'
      ? number | bigint
      : number

/** The JavaScript value a native implementation receives for a parameter of type T. */
export type ArgValue<T extends ParamType> = T extends 'char*' | 'func'
  ? string | null
  : T extends 'buffer' | 'bytes'
    ? Uint8Array | null
    : T extends `${infer B}*`
      ? NativePointer<PointeeValue<B>>
      : T extends 'float' | IntType
        ? number
        : T extends 'long'
          ? number | bigint
          : T extends 'BOOL' | 'bool'
            ? boolean
            : T extends 'Vector3'
              ? LuaVector
              : T extends 'object'
                ? Uint8Array
                : never

/** The JavaScript value a native implementation returns for a result of type T. */
export type ResultValue<T extends ResultType> = T extends 'void'
  ? void
  : T extends 'float' | IntType
    ? number
    : T extends 'long' | 'Any*'
      ? number | bigint
      : T extends 'BOOL' | 'bool'
        ? boolean
        : T extends 'char*' | 'func'
          ? string | Uint8Array | null
          : T extends 'Vector3'
            ? Vector3Like
            : T extends 'object'
              ? Uint8Array
              : never
