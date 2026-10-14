import { describe, expect, it } from 'vitest'

import { Hook } from '../src/core/hook.ts'

describe('Hook', () => {
  it('runs callbacks by ascending order, and those of the same order as they were connected', () => {
    const hook = new Hook()
    const ran: string[] = []
    hook.connect(() => {
      ran.push('b')
    })
    hook.connect(() => {
      ran.push('c')
    }, 10)
    hook.connect(() => {
      ran.push('a')
    }, -10)
    hook.connect(() => {
      ran.push('b again')
    })
    expect(hook.run()).toBe(true)
    expect(ran).toEqual(['a', 'b', 'b again', 'c'])
  })

  it('gives each callback what it runs with', () => {
    const hook = new Hook<[string, number]>()
    const ran: string[] = []
    for (const order of [1, 0]) {
      hook.connect((name, count) => {
        ran.push(`${order}: ${name} ${count}`)
      }, order)
    }
    hook.run('a', 2)
    expect(ran).toEqual(['0: a 2', '1: a 2'])
  })

  it('disconnects callbacks by the cookies it counts from 0, and says whether any is connected', () => {
    const hook = new Hook()
    const ran: string[] = []
    expect(hook.connected).toBe(false)
    const cookies = ['a', 'b', 'c'].map((name, i) =>
      hook.connect(() => {
        ran.push(name)
      }, 2 - i),
    )
    hook.disconnect(cookies[1]!)
    hook.disconnect(99)
    hook.run()
    hook.disconnect(cookies[2]!)
    expect([cookies, ran, hook.connected]).toEqual([[0, 1, 2], ['c', 'a'], true])
    hook.disconnect(cookies[0]!)
    expect(hook.connected).toBe(false)
  })

  it('runs a callback disconnected right after the one running, as FiveM finds it first', () => {
    const hook = new Hook()
    const ran: string[] = []
    let next = -1
    hook.connect(() => {
      ran.push('first')
      hook.disconnect(next)
    })
    next = hook.connect(() => {
      ran.push('next')
    })
    hook.run()
    hook.run()
    expect(ran).toEqual(['first', 'next', 'first'])
  })

  it('stops at a callback that returns false, and returns false', () => {
    const hook = new Hook()
    const ran: string[] = []
    hook.connect(() => {
      ran.push('a')
      return true
    })
    hook.connect(() => {
      ran.push('b')
      return false
    })
    hook.connect(() => {
      ran.push('c')
    })
    expect(hook.run()).toBe(false)
    expect(ran).toEqual(['a', 'b'])
  })

  it('runs a callback connected while it runs only if it comes after the next one, as FiveM does', () => {
    const hook = new Hook()
    const ran: string[] = []
    let connected = false
    hook.connect(() => {
      ran.push('first')
      if (connected) return
      connected = true
      hook.connect(() => {
        ran.push('right after')
      }, 5)
      hook.connect(() => {
        ran.push('further on')
      }, 20)
    })
    hook.connect(() => {
      ran.push('next')
    }, 10)
    hook.run()
    expect(ran).toEqual(['first', 'next', 'further on'])
    ran.length = 0
    hook.run()
    expect(ran).toEqual(['first', 'right after', 'next', 'further on'])
  })
})
