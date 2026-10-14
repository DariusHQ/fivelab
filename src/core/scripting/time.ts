/**
 * A time zone, as MSVC's runtime knows the local one: offsets in minutes
 * that local time is ahead of UTC.
 */
export interface TimeZone {
  /** The offset of local time at the UTC time `time`, in milliseconds since the epoch, with DST. */
  offset(time: number): number
  /** The offset of standard time, which MSVC's _timezone gives in seconds the other way. */
  readonly standardOffset: number
  /** The minutes that DST moves clocks ahead, which MSVC's _dstbias gives in seconds the other way: 0 without DST. */
  readonly dstBias: number
  /** The names of standard and of daylight time, as MSVC's _tzname has them. */
  readonly names: readonly [standard: string, daylight: string]
}

/** UTC, as a time zone. */
export const UTC: TimeZone = {
  offset: () => 0,
  standardOffset: 0,
  dstBias: 0,
  names: ['Coordinated Universal Time', 'Coordinated Universal Time'],
}

/**
 * The time zone that JavaScript takes local time in, as the host's, with
 * the offsets and names it has in the year of `now`: standard time is the
 * lesser of the offsets of January and July, as zones in either hemisphere
 * move clocks ahead for summer.
 */
export function localTimeZone(now = Date.now()): TimeZone {
  // JavaScript counts minutes behind UTC, and 0 - 0 is 0 where -0 is not.
  const offsetAt = (time: number) => 0 - new Date(time).getTimezoneOffset()
  const year = new Date(now).getFullYear()
  const january = new Date(year, 0, 1)
  const july = new Date(year, 6, 1)
  const offsets = [january, july].map((date) => offsetAt(date.getTime()))
  const standardOffset = Math.min(...offsets)
  const name = (date: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')!.value
  const [standardDate, daylightDate] =
    offsets[0] === standardOffset ? [january, july] : [july, january]
  return {
    offset: offsetAt,
    standardOffset,
    dstBias: Math.max(...offsets) - standardOffset,
    names: [name(standardDate), name(daylightDate)],
  }
}

/** A time broken down into its parts, as C's struct tm: but with the year in full. */
export interface BrokenDownTime {
  readonly sec: number
  readonly min: number
  readonly hour: number
  /** The day of the month, from 1. */
  readonly mday: number
  /** The month, from 0. */
  readonly mon: number
  readonly year: number
  /** The day of the week, from 0 for Sunday. */
  readonly wday: number
  /** The day of the year, from 0. */
  readonly yday: number
  /** Whether DST is in effect. */
  readonly isdst: boolean
}

/** The last second that MSVC's 64-bit time functions take: 3000-12-31 23:59:59 UTC. */
export const MAX_TIME = 32_535_215_999

const DAY = 86_400

/** The parts of a time in seconds since the epoch, as UTC. */
function partsOf(time: number, isdst: boolean): BrokenDownTime {
  const date = new Date(time * 1000)
  const year = date.getUTCFullYear()
  const yday = Math.floor((time - Date.UTC(year, 0, 1) / 1000) / DAY)
  return {
    sec: date.getUTCSeconds(),
    min: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    mday: date.getUTCDate(),
    mon: date.getUTCMonth(),
    year,
    wday: date.getUTCDay(),
    yday,
    isdst,
  }
}

/**
 * The parts of a time as UTC, as MSVC's gmtime_s gives them, or undefined
 * for those before the epoch or after MAX_TIME, which it fails for.
 */
export function utcTime(time: number): BrokenDownTime | undefined {
  if (time < 0 || time > MAX_TIME) return undefined
  return partsOf(time, false)
}

/**
 * The parts of a time as local time in `zone`, as MSVC's localtime_s gives
 * them, or undefined for those that it fails for: before the epoch or after
 * MAX_TIME, or whose local time is before the epoch.
 */
export function localTime(time: number, zone: TimeZone): BrokenDownTime | undefined {
  if (time < 0 || time > MAX_TIME) return undefined
  const offset = zone.offset(time * 1000)
  const local = time + offset * 60
  if (local < 0) return undefined
  return partsOf(local, offset !== zone.standardOffset)
}

/** The parts of a local time that mktime takes: those of C's struct tm it reads, with the year in full. */
export interface TimeFields {
  readonly sec: number
  readonly min: number
  readonly hour: number
  readonly mday: number
  /** The month, from 0, which may run past the year, as all fields may run past theirs. */
  readonly mon: number
  readonly year: number
  /** Whether the time is in DST, or undefined for mktime to tell. */
  readonly isdst: boolean | undefined
}

/**
 * The time in seconds since the epoch of a local time in `zone`, as MSVC's
 * _mktime64 takes it: fields past their ranges carry into the next, DST is
 * in effect when the fields say so, or when it is at that time, and times
 * before the epoch or after MAX_TIME give -1.
 */
export function makeTime(fields: TimeFields, zone: TimeZone): number {
  const date = new Date(0)
  date.setUTCFullYear(fields.year, fields.mon, fields.mday)
  date.setUTCHours(fields.hour, fields.min, fields.sec)
  const wall = date.getTime() / 1000
  if (Number.isNaN(wall)) return -1
  let time = wall - zone.standardOffset * 60
  const isdst = fields.isdst ?? zone.offset(time * 1000) !== zone.standardOffset
  if (isdst) time -= zone.dstBias * 60
  return time < 0 || time > MAX_TIME ? -1 : time
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** A number with `digits` digits at least, as strftime writes them, or none of the zeros in front with #. */
function digits(value: number, count: number, alternate: boolean): string {
  return alternate ? String(value) : String(value).padStart(count, '0')
}

/** The offset of a time zone as %z writes it: +hhmm or -hhmm. */
function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${digits(Math.floor(absolute / 60), 2, false)}${digits(absolute % 60, 2, false)}`
}

/**
 * Writes one conversion of `time`, as MSVC's strftime does in the C
 * locale: `spec` is what follows %, such as a or #d, where # leaves the
 * zeros out of numbers and makes %c and %x long. %z and %Z say the offset
 * and the name of standard or of daylight time, as the time says it is.
 */
export function strftime(spec: string, time: BrokenDownTime, zone: TimeZone): string {
  const alternate = spec.startsWith('#')
  const { sec, min, hour, mday, mon, year, wday, yday } = time
  const date = (long: boolean) =>
    long
      ? `${DAYS[wday]}, ${MONTHS[mon]} ${digits(mday, 2, false)}, ${year}`
      : `${digits(mon + 1, 2, false)}/${digits(mday, 2, false)}/${digits(year % 100, 2, false)}`
  const clock = `${digits(hour, 2, false)}:${digits(min, 2, false)}:${digits(sec, 2, false)}`
  switch (spec.at(-1)) {
    case 'a':
      return DAYS[wday]!.slice(0, 3)
    case 'A':
      return DAYS[wday]!
    case 'b':
      return MONTHS[mon]!.slice(0, 3)
    case 'B':
      return MONTHS[mon]!
    case 'c':
      return `${date(alternate)} ${clock}`
    case 'x':
      return date(alternate)
    case 'X':
      return clock
    case 'd':
      return digits(mday, 2, alternate)
    case 'H':
      return digits(hour, 2, alternate)
    case 'I':
      return digits(hour % 12 || 12, 2, alternate)
    case 'j':
      return digits(yday + 1, 3, alternate)
    case 'm':
      return digits(mon + 1, 2, alternate)
    case 'M':
      return digits(min, 2, alternate)
    case 'S':
      return digits(sec, 2, alternate)
    case 'p':
      return hour < 12 ? 'AM' : 'PM'
    case 'U':
      return digits(Math.floor((yday + 7 - wday) / 7), 2, alternate)
    case 'W':
      return digits(Math.floor((yday + 7 - ((wday + 6) % 7)) / 7), 2, alternate)
    case 'w':
      return String(wday)
    case 'y':
      return digits(year % 100, 2, alternate)
    case 'Y':
      return String(year)
    case 'z':
      return offsetText(zone.standardOffset + (time.isdst ? zone.dstBias : 0))
    case 'Z':
      return zone.names[time.isdst ? 1 : 0]
    default:
      return '%'
  }
}
