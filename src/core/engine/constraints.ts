import { atoi } from '../libc.ts'

/** The build of FiveM that FiveLab follows, whose typings its natives come from. */
export const FIVEM_BUILD = 37175

/** The version that FiveM's servers of that build say they run, as those of Linux say it. */
export const FIVEM_VERSION = `FXServer-master SERVER v1.0.0.${FIVEM_BUILD} linux`

/** The game build that FiveM's server enforces unless sv_enforceGameBuild says otherwise. */
export const DEFAULT_GAME_BUILD = 3258

/**
 * What a constraint holds: a number that values must not exceed, a flag, a
 * string that values must equal, or a check of the value, which passes with
 * true and fails with false, or with why.
 */
export type Constraint = number | boolean | string | ((value: string) => boolean | string)

/** How a dependency fares as a constraint: none when it is no constraint, else whether it passes. */
export type ConstraintResult = 'none' | 'pass' | { readonly error: string }

const EXPRESSION = /^\/([a-z/0-9_-]+)(?::([a-z/0-9_-]+))?$/i

/**
 * The constraints that dependencies such as /server:5181 or /onesync test,
 * as FiveM's resource manager has them. Unless they are enforced, as only
 * servers do, failing constraints pass.
 */
export class Constraints {
  enforcing = false
  readonly #constraints = new Map<string, Constraint>()

  register(key: string, constraint: Constraint): void {
    this.#constraints.set(key, constraint)
  }

  /** Tests a dependency as FiveM does: those that start with / are constraints. */
  match(expression: string): ConstraintResult {
    if (!expression.startsWith('/')) return 'none'
    const parts = EXPRESSION.exec(expression)
    if (parts === null) return this.#fail('constraint syntax error')
    const key = parts[1]!
    const value = parts[2] ?? ''
    const constraint = this.#constraints.get(key)
    if (constraint === undefined) return this.#fail(`constraint '${key}' is unknown`)
    if (value === '') {
      // Without a value, numbers and strings pass, but flags and checks are tested.
      if (constraint === false) return this.#fail(`${key} isn't enabled`)
      if (typeof constraint === 'function') {
        const result = check(constraint, value)
        if (result !== true) return this.#fail(`${key}: ^1${result}^7`)
      }
      return 'pass'
    }
    switch (typeof constraint) {
      case 'number': {
        const least = atoi(value)
        if (constraint < least) return this.#fail(`${key} needs to be ${least} or higher`)
        break
      }
      case 'boolean':
        if (constraint && value === 'false') return this.#fail(`${key} needs to be disabled`)
        if (!constraint && value === 'true') return this.#fail(`${key} needs to be enabled`)
        if (value !== 'true' && value !== 'false') return this.#fail(`${value} isn't a boolean`)
        break
      case 'string':
        if (constraint !== value) return this.#fail(`${key} needs to be ${value}`)
        break
      default: {
        const result = check(constraint, value)
        if (result !== true) return this.#fail(`${key}(${value}): ^1${result}^7`)
      }
    }
    return 'pass'
  }

  #fail(error: string): ConstraintResult {
    return this.enforcing ? { error } : 'pass'
  }
}

/** Runs a check, and returns true or why it failed, which FiveM gives as no details by default. */
function check(constraint: (value: string) => boolean | string, value: string): true | string {
  const result = constraint(value)
  if (result === true) return true
  return result === false ? 'no details specified' : result
}

/** The game builds of FiveM by the names of the updates that brought them. */
const GAME_BUILDS = new Map([
  ['mpchristmas2018', 1604],
  ['mpsum', 2060],
  ['mpheist4', 2189],
  ['mptuner', 2372],
  ['mpsecurity', 2545],
  ['mpg9ec', 2612],
  ['mpsum2', 2699],
  ['mpchristmas3', 2802],
  ['mp2023_01', 2944],
  ['mp2023_02', 3095],
  ['mp2024_01', 3258],
  ['mp2024_02', 3407],
  ['mp2025_01', 3570],
  ['mp2025_02', 3751],
  ['mp2026_patch_01', 3788],
  ['mp2026_01', 3889],
])

/**
 * The game build a value names, as FiveM's server reads them: a number as
 * written, or the name of an update, such as mpsum2, sum2, h4 or xm18.
 */
export function parseGameBuild(value: string): number | undefined {
  if (/^-?\d+$/.test(value)) {
    const build = Number(value)
    // stoi reads 007 as 7, which FiveM then takes for a name.
    if (String(build) === value && build >= -(2 ** 31) && build < 2 ** 31) return build
  }
  let name = value
  if (name.startsWith('xm') && name.length === 4) name = `christmas20${name.slice(2)}`
  if (name.startsWith('h') && name.length === 2) name = `mpheist${name.slice(1)}`
  if (!name.startsWith('mp')) name = `mp${name}`
  return GAME_BUILDS.get(name.toLowerCase())
}
