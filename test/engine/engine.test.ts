import { describe, expect, it } from 'vitest'

import { Engine, type EngineOptions } from '../../src/core/engine/index.ts'
import { cfxlua } from '../lua/helpers.ts'

/** An engine whose processes write lines of what scripts print, as "process: text". */
async function createEngine(options: Partial<EngineOptions> = {}) {
  const lines: string[] = []
  const engine = await Engine.create({
    cfxlua: await cfxlua(),
    output: ({ name }) => {
      let partial = ''
      return {
        write: (channel, text) => {
          if (!channel.startsWith('script:')) return
          const pieces = (partial + text).split('\n')
          partial = pieces.pop()!
          for (const piece of pieces) lines.push(`${name}: ${piece}`)
        },
        warn: () => {},
        diagnose: () => {},
      }
    },
    ...options,
  })
  const take = () => lines.splice(0)
  return { engine, take }
}

const MANIFEST = `fx_version 'cerulean'
game 'gta5'
client_script 'client.lua'
server_script 'server.lua'`

describe('Engine', () => {
  it('runs the frames of its server every 50 ms, as FiveM does', async () => {
    const { engine, take } = await createEngine()
    engine.server
      .addResource('a', {
        files: {
          'fxmanifest.lua': MANIFEST,
          'server.lua': `CreateThread(function()
    for _ = 1, 3 do
        print(GetGameTimer())
        Wait(0)
    end
end)`,
          'client.lua': '',
        },
      })
      .start()
    engine.advance(120)
    const early = take()
    engine.advance(40)
    expect([early, take(), engine.clock.now]).toEqual([
      ['server: 50', 'server: 100'],
      ['server: 150'],
      160,
    ])
  })

  it('connects clients, which join as the clock moves, each with a time of its own', async () => {
    const { engine, take } = await createEngine()
    engine.server
      .addResource('a', {
        files: {
          'fxmanifest.lua': MANIFEST,
          'server.lua': `AddEventHandler('playerJoining', function() print('joining', source, GetGameTimer()) end)`,
          'client.lua': `print('started', GetGameTimer())`,
        },
      })
      .start()
    engine.advance(1000)
    const { client, player } = await engine.connect({ name: 'Ann' })
    expect([player.state, engine.clients]).toEqual(['connecting', [client]])
    engine.advance(500)
    // The player joins at the second frame of the server, and its client starts the resources at
    // its first game frame after that, 116 ms into its time.
    expect([player.state, player.name, take()]).toEqual([
      'joined',
      'Ann',
      ['server: joining\t1\t1100', 'client 1: started\t116'],
    ])
  })

  it('writes nowhere without output', async () => {
    const engine = await Engine.create({ cfxlua: await cfxlua() })
    engine.server
      .addResource('a', {
        files: { 'main.lua': `print('quiet') CreateThread(function() Wait(0) error('loud') end)` },
        metadata: [['server_script', 'main.lua']],
      })
      .start()
    await engine.connect()
    expect(() => engine.advance(1000)).not.toThrow()
  })

  it('runs the game frames of clients as often as told', async () => {
    const { engine } = await createEngine({ clientFrameTime: 100 })
    const { client } = await engine.connect()
    let ticks = 0
    const tick = client.tick.bind(client)
    client.tick = () => {
      ticks++
      tick()
    }
    engine.advance(1000)
    expect(ticks).toBe(10)
  })
})
