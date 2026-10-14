import { describe, expect, it } from 'vitest'

import { Clock } from '../../src/core/engine/index.ts'

describe('Clock', () => {
  it('runs timers at the times they are due, by time, then in the order they came', () => {
    const clock = new Clock()
    const ran: string[] = []
    clock.every(50, () => ran.push(`a ${clock.now}`))
    clock.every(20, () => ran.push(`b ${clock.now}`))
    clock.every(50, () => ran.push(`c ${clock.now}`))
    clock.advance(99)
    const first = clock.now
    clock.advance(1)
    expect([ran, first, clock.now]).toEqual([
      ['b 20', 'b 40', 'a 50', 'c 50', 'b 60', 'b 80', 'a 100', 'b 100', 'c 100'],
      99,
      100,
    ])
  })

  it('runs timers of intervals that are not whole without drifting', () => {
    const clock = new Clock()
    const times: number[] = []
    clock.every(1000 / 60, () => times.push(clock.now))
    clock.advance(1000)
    clock.advance(1000)
    expect([times.length, times[59], times[119]]).toEqual([120, 1000, 2000])
  })

  it('runs no timer that one stops, and those that one adds from their own time', () => {
    const clock = new Clock()
    const ran: string[] = []
    let stopLater = () => {}
    clock.every(10, () => {
      ran.push(`first ${clock.now}`)
      if (clock.now === 10) {
        stopLater()
        clock.every(5, () => ran.push(`added ${clock.now}`))
      }
    })
    stopLater = clock.every(10, () => ran.push(`later ${clock.now}`))
    const stopSelf = clock.every(10, () => {
      ran.push(`self ${clock.now}`)
      stopSelf()
      stopSelf()
    })
    clock.advance(20)
    expect(ran).toEqual(['first 10', 'self 10', 'added 15', 'first 20', 'added 20'])
  })

  it('stops at the time of a timer that throws', () => {
    const clock = new Clock()
    clock.every(30, () => {
      throw new Error('broke')
    })
    expect(() => clock.advance(100)).toThrow('broke')
    expect(clock.now).toBe(30)
    // The timer runs next at its next time.
    expect(() => clock.advance(29)).not.toThrow()
    expect(() => clock.advance(1)).toThrow('broke')
  })

  it('takes no intervals that are not more than 0, nor moves back', () => {
    const clock = new Clock()
    expect(() => clock.every(0, () => {})).toThrow(
      new RangeError('Clock intervals must be more than 0 ms, not 0'),
    )
    expect(() => clock.every(Number.NaN, () => {})).toThrow(RangeError)
    expect(() => clock.advance(-1)).toThrow(new RangeError('Clocks move forward, not by -1 ms'))
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError)
    clock.advance(0)
    expect(clock.now).toBe(0)
  })
})
