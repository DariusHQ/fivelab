export type LuaVectorType = 'vector2' | 'vector3' | 'vector4' | 'quat'

/**
 * A CfxLua vector or quaternion. Components are single-precision floats, as in
 * Lua; unused components are 0. Quaternions keep x, y, z and w by name.
 */
export class LuaVector {
  readonly type: LuaVectorType
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number

  constructor(type: LuaVectorType, x: number, y: number, z = 0, w = 0) {
    this.type = type
    this.x = Math.fround(x)
    this.y = Math.fround(y)
    this.z = Math.fround(z)
    this.w = Math.fround(w)
  }
}

/** A number that reaches Lua as a float even when it is integral, as native float results do. */
export class LuaFloat {
  readonly value: number

  constructor(value: number) {
    this.value = value
  }
}
