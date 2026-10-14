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
