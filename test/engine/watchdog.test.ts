import { describe, expect, it } from 'vitest'

import { createProcess, startResource } from './helpers.ts'

describe('The watchdog of processes', () => {
  it('interrupts scripts that run too long, and leaves them running after', async () => {
    const proc = await createProcess({ watchdog: { timeoutMs: 50, interval: 100 } })
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(pcall(function() while true do end end))
CreateThread(function()
    Wait(0)
    while true do end
end)
print('after')`,
      }),
    ).toEqual([
      '[script:a] false\t@a/main.lua:1: script ran for more than 50 ms without yielding (missing Wait in a loop?)',
      '[script:a] after',
    ])
    proc.tickAt(0)
    proc.tickAt(1)
    // The report of the thread's error runs too, as the watchdog raised its error once.
    expect(proc.take()).toEqual([
      '[script:a] ^1SCRIPT ERROR: @a/main.lua:4: script ran for more than 50 ms without yielding (missing Wait in a loop?)^7',
    ])
  })
})
