import { afterEach, describe, expect, it } from 'vitest'

import { localTimeZone, makeTime, UTC } from '../../src/core/scripting/time.ts'

const timeZone = process.env.TZ

afterEach(() => {
  if (timeZone === undefined) delete process.env.TZ
  else process.env.TZ = timeZone
})

/** The time zone of the host while it is `name`, in 2023. */
function zone(name: string) {
  process.env.TZ = name
  const found = localTimeZone(Date.UTC(2023, 5, 1))
  return {
    standardOffset: found.standardOffset,
    dstBias: found.dstBias,
    names: found.names,
    winter: found.offset(Date.UTC(2023, 0, 15)),
    summer: found.offset(Date.UTC(2023, 6, 15)),
  }
}

describe('The local time zone', () => {
  it('is that of JavaScript, with standard time the lesser offset of January and July', () => {
    expect([zone('America/New_York'), zone('Australia/Sydney'), zone('UTC')]).toEqual([
      {
        standardOffset: -300,
        dstBias: 60,
        names: ['Eastern Standard Time', 'Eastern Daylight Time'],
        winter: -300,
        summer: -240,
      },
      {
        standardOffset: 600,
        dstBias: 60,
        names: ['Australian Eastern Standard Time', 'Australian Eastern Daylight Time'],
        winter: 660,
        summer: 600,
      },
      {
        standardOffset: 0,
        dstBias: 0,
        names: ['Coordinated Universal Time', 'Coordinated Universal Time'],
        winter: 0,
        summer: 0,
      },
    ])
  })
})

describe('makeTime', () => {
  it('gives -1 for dates past what dates hold', () => {
    const fields = { sec: 0, min: 0, hour: 0, mday: 1, mon: 0, isdst: undefined }
    expect([
      makeTime({ ...fields, year: 1970 }, UTC),
      makeTime({ ...fields, year: 300_000 }, UTC),
    ]).toEqual([0, -1])
  })
})
