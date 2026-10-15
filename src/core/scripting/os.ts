import {
  LuaArgumentError,
  LuaCallerError,
  LuaFloat,
  type HostArgs,
  type LuaRef,
  type LuaState,
  type LuaValue,
} from '../lua/index.ts'
import { LUA_TNIL, LUA_TTABLE } from '../lua/abi.ts'
import {
  checkCString,
  checkInteger,
  checkOption,
  checkString,
  isNoneOrNil,
  optionalString,
  typeError,
  untilNul,
} from './checks.ts'
import { localTime, makeTime, strftime, utcTime, type TimeZone } from './time.ts'

/** What FiveM's os library reaches of the process, which it has on servers. */
export interface OsHost {
  /** Milliseconds since the epoch, by the wall clock, which time() reads. */
  wallClock(): number
  /** The time zone that local times are in. */
  readonly timeZone: TimeZone
  /** Milliseconds since the process started, which MSVC's clock counts. */
  processTime(): number
  /** Microseconds on the steady clock of the machine, which os.microtime and os.nanotime read. */
  steadyClock(): number
  /** The number of the next name os.tmpname gives, counted across the process from 1. */
  nextTemporaryName(): number
  /**
   * Creates a directory at a path that a script gives, through FiveM's
   * VFS: 'exists' if something is there already, 'failed' if it cannot.
   */
  createDirectory(path: string): 'created' | 'exists' | 'failed'
  /** Removes a file at a path that a script gives, if its resource may write it, and returns whether it did. */
  remove(path: string): boolean
  /** Moves a file at a path that a script gives to another, if its resource may write both, and returns whether it did. */
  rename(from: string, to: string): boolean
}

/** The options os.date takes, as FiveM's Windows build does: one character, then two that start with #. */
const DATE_OPTIONS = new Set([
  ...'aAbBcdHIjmMpSUwWxXyYzZ%',
  ...'cxdHIjmMSUwWyY'.split('').map((c) => `#${c}`),
])

/** strerror(EACCES), which FiveM's os gives for what it refuses. */
const EACCES = 13
const PERMISSION_DENIED = 'Permission denied'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** The categories os.setlocale takes, which FiveM checks but sets no locale of. */
const LOCALE_CATEGORIES = ['all', 'collate', 'ctype', 'monetary', 'numeric', 'time']

/**
 * The os library of FiveM's servers: Lua's, but that os.exit is gone,
 * os.execute runs nothing, os.getenv says only which system runs the
 * server, os.setlocale changes nothing, files move through FiveM's VFS and
 * its permissions, and os.deltatime, os.microtime, os.nanotime, os.rdtsc
 * and os.rdtscp read clocks of the machine. Times are those of MSVC's
 * runtime, as FiveM's Windows build has them.
 */
export function osLibrary(state: LuaState, host: OsHost): LuaRef {
  const now = () => Math.floor(host.wallClock() / 1000)
  const nanoseconds = () => BigInt(Math.floor(host.steadyClock() * 1000))
  const functions: [string, (args: HostArgs) => LuaValue | LuaValue[]][] = [
    ['clock', () => new LuaFloat(Math.trunc(host.processTime()) / 1000)],
    [
      'date',
      (args) => {
        let format = untilNul(optionalString(args, 1) ?? encoder.encode('%c'))
        const time = isNoneOrNil(args, 2) ? now() : Number(checkInteger(args, 2))
        const utc = format[0] === 0x21 // !
        if (utc) format = format.subarray(1)
        const parts = utc ? utcTime(time) : localTime(time, host.timeZone)
        if (parts === undefined) return null
        if (decoder.decode(format) === '*t') {
          return state.createTable([
            ['sec', parts.sec],
            ['min', parts.min],
            ['hour', parts.hour],
            ['day', parts.mday],
            ['month', parts.mon + 1],
            ['year', parts.year],
            ['wday', parts.wday + 1],
            ['yday', parts.yday + 1],
            ['isdst', parts.isdst],
          ])
        }
        const out: number[] = []
        for (let i = 0; i < format.length; i++) {
          if (format[i] !== 0x25) {
            out.push(format[i]!)
            continue
          }
          // FiveM ends the format at a % that ends it, where Lua fails.
          if (i + 1 === format.length) break
          const rest = decoder.decode(format.subarray(i + 1))
          const spec = [rest.slice(0, 1), rest.slice(0, 2)].find((option) =>
            DATE_OPTIONS.has(option),
          )
          if (spec === undefined)
            throw new LuaArgumentError(1, `invalid conversion specifier '%${rest}'`)
          out.push(...encoder.encode(strftime(spec, parts, host.timeZone)))
          i += spec.length
        }
        return Uint8Array.from(out)
      },
    ],
    [
      'difftime',
      (args) => {
        const t1 = checkInteger(args, 1)
        const t2 = checkInteger(args, 2)
        return new LuaFloat(Number(t1) - Number(t2))
      },
    ],
    [
      'execute',
      (args) => {
        if (optionalString(args, 1) === undefined) return true
        return [null, PERMISSION_DENIED, EACCES]
      },
    ],
    ['getenv', (args) => (checkCString(args, 1).toLowerCase() === 'os' ? 'Windows' : null)],
    [
      'createdir',
      (args) => {
        const path = checkCString(args, 1)
        const result = host.createDirectory(path)
        if (result === 'created') return true
        return [
          null,
          `${path}: ${result === 'exists' ? 'Directory already exists.' : 'Failed to create directory'}`,
          1,
        ]
      },
    ],
    [
      'remove',
      (args) => {
        const path = checkCString(args, 1)
        return host.remove(path) ? true : [null, `${path}: ${PERMISSION_DENIED}`, EACCES]
      },
    ],
    [
      'rename',
      (args) => {
        const from = checkCString(args, 1)
        const to = checkCString(args, 2)
        return host.rename(from, to)
          ? true
          : [null, `${from} -> ${to}: ${PERMISSION_DENIED}`, EACCES]
      },
    ],
    [
      'setlocale',
      (args) => {
        const locale = optionalString(args, 1)
        checkOption(args, 2, 'all', LOCALE_CATEGORIES)
        return locale === undefined ? null : untilNul(locale)
      },
    ],
    [
      'time',
      (args) => {
        if (isNoneOrNil(args, 1)) return BigInt(now())
        if (args.type(1) !== LUA_TTABLE) typeError(args, 1, 'table')
        const field = (key: string, fallback: number) => {
          const value = args.withField(1, key, (at) =>
            args.isIntegral(at) ? args.integer(at) : undefined,
          )
          if (value !== undefined) return Number(BigInt.asIntN(32, value))
          if (fallback < 0) throw new LuaCallerError(`field '${key}' missing in date table`)
          return fallback
        }
        const sec = field('sec', 0)
        const min = field('min', 0)
        const hour = field('hour', 12)
        const mday = field('day', -1)
        const mon = field('month', -1) - 1
        const year = field('year', -1)
        const isdst = args.withField(1, 'isdst', (at) =>
          args.type(at) === LUA_TNIL ? undefined : args.boolean(at),
        )
        const time = makeTime({ sec, min, hour, mday, mon, year, isdst }, host.timeZone)
        return time === -1 ? null : BigInt(time)
      },
    ],
    ['tmpname', () => `tmp_${host.nextTemporaryName()}`],
    [
      'deltatime',
      (args) => {
        // The difference of the unsigned integers, which Lua gets back as signed, as it gets all bigints.
        const end = BigInt.asUintN(64, checkInteger(args, 1))
        const start = BigInt.asUintN(64, checkInteger(args, 2))
        return start <= end ? end - start : start - end
      },
    ],
    ['microtime', () => BigInt(Math.floor(host.steadyClock()))],
    ['nanotime', () => nanoseconds()],
    // Cycles of a processor of 3 GHz, which counts them from the time the machine started.
    ['rdtsc', () => nanoseconds() * 3n],
    ['rdtscp', () => nanoseconds() * 3n],
  ]
  return state.createTable(functions.map(([name, fn]) => [name, state.hostFunction(fn)]))
}
