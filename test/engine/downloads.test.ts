import { describe, expect, it } from 'vitest'

import { INT32_MIN } from '../../src/core/hook.ts'
import { Session } from '../../src/core/engine/index.ts'
import { createProcess, join, type TestProcess } from './helpers.ts'

/** An fxmanifest.lua with `lines` after its version and game. */
function manifest(...lines: string[]): string {
  return [`fx_version 'cerulean'`, `game 'gta5'`, ...lines].join('\n')
}

/** A script that prints the names of the resources that stop, as onResourceStop tells it. */
const STOPS = `AddEventHandler('onResourceStop', function(name) print('stop', name) end)`

/** A resource whose client script prints its name. */
function printing(name: string, ...lines: string[]): Record<string, string> {
  return {
    'fxmanifest.lua': manifest(`client_script 'client.lua'`, ...lines),
    'client.lua': `print('${name}')`,
  }
}

async function serverWithSession(): Promise<{ server: TestProcess; session: Session }> {
  const server = await createProcess()
  return { server, session: new Session(server.manager) }
}

/** What the scripts of a process printed since it was last asked. */
function scripts(proc: TestProcess): string[] {
  return proc.take().filter((line) => line.startsWith('[script:'))
}

/** Ticks a client twice, the ticks it takes to download the resources of its server and start them. */
function load(client: TestProcess): void {
  client.manager.tick()
  client.manager.tick()
}

describe('The resources of servers on clients', () => {
  it('start on clients that join, but for those that are server_only, in the order they started', async () => {
    const { server, session } = await serverWithSession()
    for (const [name, files] of [
      ['b', printing('b')],
      ['a', printing('a')],
      ['only', printing('only', `server_only 'yes'`)],
      ['never', printing('never')],
      ['late', printing('late')],
    ] as const) {
      server.add(name, files)
    }
    for (const name of ['b', 'a', 'only', 'late']) server.manager.getResource(name)!.start()
    // A restart moves a resource to the end of the order.
    server.manager.getResource('b')!.stop()
    server.manager.getResource('b')!.start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    client.manager.tick()
    expect(scripts(client)).toEqual([])
    client.manager.tick()
    expect(scripts(client)).toEqual(['[script:a] a', '[script:late] late', '[script:b] b'])
    expect(client.manager.getResource('only')).toBe(undefined)
    expect(client.manager.getResource('never')).toBe(undefined)
  })

  it('come after those started, from those that became no longer server_only', async () => {
    const { server, session } = await serverWithSession()
    const only = server.add('only', printing('only', `server_only 'yes'`))
    only.start()
    server.add('a', printing('a')).start()
    server.manager.files.write(
      'resources/only/fxmanifest.lua',
      new TextEncoder().encode(manifest(`client_script 'client.lua'`)),
    )
    only.reloadMetadata(only.path)
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    expect(scripts(client)).toEqual(['[script:a] a', '[script:only] only'])
  })

  it('leave out those that went away though they would not stop, rather than those that provide them', async () => {
    const { server, session } = await serverWithSession()
    const gone = server.add('gone', printing('gone'))
    gone.start()
    server.add('z', printing('z')).start()
    server.add('p', printing('p', `provide 'gone'`)).start()
    // A resource that would not stop keeps its place in the start order as its server removes it.
    gone.onStop.connect(() => false, INT32_MIN)
    server.manager.removeResource(gone)
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    expect(scripts(client)).toEqual(['[script:z] z', '[script:p] p'])
  })

  it('have only the files that servers send clients', async () => {
    const { server, session } = await serverWithSession()
    server
      .add('a', {
        'fxmanifest.lua': manifest(
          `client_script 'client.lua'`,
          `server_script 'server.lua'`,
          `file 'html/*'`,
        ),
        'client.lua': '',
        'server.lua': '',
        'html/index.html': '<html></html>',
      })
      .start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    const resource = client.manager.getResource('a')!
    expect(
      ['fxmanifest.lua', 'client.lua', 'server.lua', 'html/index.html'].map(
        (file) => resource.file(file) !== undefined,
      ),
    ).toEqual([true, true, false, true])
    // Clients keep what they get where FiveM's do, and pack nothing for others.
    expect([resource.path, resource.packedForClients]).toEqual(['resources:/a/', undefined])
  })

  it('take the entries of resources without manifests from the server', async () => {
    const { server, session } = await serverWithSession()
    server
      .add('a', { 'client.lua': `print('a')` }, [
        ['fx_version', 'cerulean'],
        ['client_script', 'client.lua'],
      ])
      .start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    expect(scripts(client)).toEqual(['[script:a] a'])
  })

  it('replace the resources of clients as they join, with onResourceStop', async () => {
    const { server, session } = await serverWithSession()
    server.add('a', printing('a')).start()
    const client = await createProcess({ side: 'client' })
    const own = client.add('own', { 'main.lua': STOPS }, [
      ['client_script', 'main.lua'],
      ['provide', 'mine'],
    ])
    own.start()
    client.take()
    join(session, client.manager)
    expect([
      own.state,
      client.manager.getResource('own'),
      client.manager.getResource('mine'),
    ]).toEqual(['uninitialized', undefined, undefined])
    expect(scripts(client)).toEqual(['[script:own] stop\town'])
    load(client)
    expect(scripts(client)).toEqual(['[script:a] a'])
  })

  it('go from clients that leave at their next tick, once they handled what came before, without onResourceStop', async () => {
    const { server, session } = await serverWithSession()
    server
      .add('a', {
        'fxmanifest.lua': manifest(`client_script 'client.lua'`),
        'client.lua': `${STOPS}\nRegisterNetEvent('bye', function() print('bye') end)`,
      })
      .start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    client.take()
    const a = client.manager.getResource('a')!
    server
      .add('kick', { 'main.lua': `TriggerClientEvent('bye', 1) DropPlayer(1, 'Kicked')` })
      .start()
    expect(a.state).toBe('started')
    client.manager.tick()
    // FiveM's clients trigger no onResourceStop as their game session ends.
    expect(scripts(client)).toEqual(['[script:a] bye'])
    expect([a.state, client.manager.getResource('a')]).toEqual(['uninitialized', undefined])
  })

  it('go from clients that their server refuses at their next tick, with onResourceStop', async () => {
    const { server, session } = await serverWithSession()
    server
      .add('refuse', {
        'main.lua': `AddEventHandler('playerConnecting', function() CancelEvent() end)`,
      })
      .start()
    const client = await createProcess({ side: 'client' })
    const own = client.add('own', { 'main.lua': STOPS }, [['client_script', 'main.lua']])
    own.start()
    client.take()
    const player = join(session, client.manager)
    expect([player.state, own.state]).toEqual(['rejected', 'started'])
    client.manager.tick()
    expect(scripts(client)).toEqual(['[script:own] stop\town'])
    expect(client.manager.getResource('own')).toBe(undefined)
    // A client resets its resources once each time it leaves.
    const again = client.add('again', { 'main.lua': '' }, [['client_script', 'main.lua']])
    again.start()
    session.connect(client.manager)
    expect(again.state).toBe('started')
  })

  it('go from clients that left as they connect again, without onResourceStop', async () => {
    const { server, session } = await serverWithSession()
    server
      .add('a', { 'fxmanifest.lua': manifest(`client_script 'client.lua'`), 'client.lua': STOPS })
      .start()
    const client = await createProcess({ side: 'client' })
    const player = join(session, client.manager)
    load(client)
    client.take()
    const a = client.manager.getResource('a')!
    player.quit()
    session.connect(client.manager)
    expect([a.state, scripts(client)]).toEqual(['uninitialized', []])
  })

  it('do not start on clients that removed them before they would', async () => {
    const { server, session } = await serverWithSession()
    server.add('a', printing('a')).start()
    const client = await createProcess({ side: 'client' })
    const player = join(session, client.manager)
    client.manager.tick()
    const a = client.manager.getResource('a')!
    player.quit()
    session.connect(client.manager)
    client.manager.tick()
    expect([a.state, scripts(client)]).toEqual(['uninitialized', []])
  })

  it('start and stop on the clients that joined as the server starts and stops them', async () => {
    const { server, session } = await serverWithSession()
    const late = server.add('late', printing('late'))
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    late.start()
    load(client)
    expect(scripts(client)).toEqual(['[script:late] late'])
    late.stop()
    expect(client.manager.getResource('late')!.state).toBe('started')
    client.manager.tick()
    expect(client.manager.getResource('late')!.state).toBe('stopped')
  })

  it('download a resource once while its start waits, and say when they stop one they do not know', async () => {
    const { server, session } = await serverWithSession()
    const a = server.add('a', printing('a'))
    const b = server.add('b', printing('b'))
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    client.take()
    a.start()
    a.stop()
    a.start()
    load(client)
    expect(client.take().filter((line) => !line.startsWith('[resources]'))).toEqual([
      '[citizen-legacy-net-resources] Required resources: a ',
      '[citizen-scripting-core] Creating script environments for a',
      '[script:a] a',
    ])
    // Clients stop the resources they have, without removing them, and download them again as they start.
    a.stop()
    load(client)
    expect(client.manager.getResource('a')!.state).toBe('stopped')
    a.start()
    load(client)
    expect(scripts(client)).toEqual(['[script:a] a'])
    b.start()
    b.stop()
    load(client)
    // The client asks for the resource after the server stopped it, and gets none.
    expect(client.take()).toEqual([
      '[citizen-legacy-net-resources] Required resources: ',
      "[citizen-legacy-net-resources] Server requested resource b to be stopped, but we don't know that resource",
    ])
  })

  it('are named on the console of clients as they download them', async () => {
    const { server, session } = await serverWithSession()
    for (const name of ['b', 'a']) server.add(name, printing(name)).start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    client.manager.tick()
    expect(client.take()).toEqual(['[citizen-legacy-net-resources] Required resources: b a '])
    client.manager.tick()
    client.take()
    server.add('late', printing('late')).start()
    client.manager.tick()
    expect(client.take()).toEqual(['[citizen-legacy-net-resources] Required resources: late '])
  })

  it('come to clients that download them as they start', async () => {
    const { server, session } = await serverWithSession()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    const starting = server.add('starting', printing('starting'))
    // The client downloads the resources of its server while this one starts, once it is packed.
    starting.onStart.connect(() => client.manager.tick(), 1000)
    starting.start()
    expect(client.manager.getResource('starting')).not.toBe(undefined)
  })

  it('replace on clients the first started resource that provides their names, as FiveM finds it', async () => {
    const { server, session } = await serverWithSession()
    for (const name of ['p', 'q']) server.add(name, printing(name, `provide 'x'`)).start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    const [p, q] = ['p', 'q'].map((name) => client.manager.getResource(name)!)
    server.add('x', printing('x')).start()
    load(client)
    expect([p!.state, q!.state, client.manager.getResource('p'), scripts(client)]).toEqual([
      'uninitialized',
      'started',
      undefined,
      ['[script:p] p', '[script:q] q', '[script:x] x'],
    ])
  })

  it('replace on clients those of their names that resources which provide the names hide', async () => {
    const { server, session } = await serverWithSession()
    const x = server.add('x', printing('x'))
    x.start()
    server.add('p', printing('p', `provide 'x'`)).start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    const old = client.manager.getResource('x')!
    x.stop()
    load(client)
    // The client finds p by the name of x, which stopped, and removes both.
    x.start()
    load(client)
    expect([
      old.state,
      client.manager.getResource('p'),
      client.manager.getResource('x')!.state,
    ]).toEqual(['uninitialized', undefined, 'started'])
  })

  it('stop on clients the resources that provide the names of those they do not have', async () => {
    const { server, session } = await serverWithSession()
    server.add('p', printing('p', `provide 'x'`)).start()
    const x = server.add('x', printing('x'))
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    x.start()
    x.stop()
    load(client)
    expect(client.manager.getResource('p')!.state).toBe('stopped')
  })

  it('stop on clients as their server said before it dropped them, but not once they connect again', async () => {
    const { server, session } = await serverWithSession()
    const a = server.add('a', {
      'fxmanifest.lua': manifest(`client_script 'client.lua'`),
      'client.lua': STOPS,
    })
    a.start()
    const client = await createProcess({ side: 'client' })
    let player = join(session, client.manager)
    load(client)
    client.take()
    a.stop()
    session.drop(player, 'Kicked')
    client.manager.tick()
    expect(scripts(client)).toEqual(['[script:a] stop\ta'])
    a.start()
    player = join(session, client.manager)
    load(client)
    client.take()
    a.stop()
    player.quit()
    session.connect(client.manager)
    client.manager.tick()
    expect(client.take()).toEqual([])
  })

  it('do not download on clients that left before they would', async () => {
    const { server, session } = await serverWithSession()
    const client = await createProcess({ side: 'client' })
    const player = join(session, client.manager)
    load(client)
    client.take()
    server.add('late', printing('late')).start()
    player.quit()
    client.manager.tick()
    expect([client.manager.getResource('late'), client.take()]).toEqual([undefined, []])
  })

  it('fail to load on clients that download them before their server first packed them', async () => {
    const { server, session } = await serverWithSession()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    const starting = server.add('starting', printing('starting'))
    starting.onStart.connect(() => client.manager.tick())
    starting.start()
    expect(client.diagnostics).toEqual([
      `starting: FiveM's client would stop with the error "Couldn't load resource starting: Could not open resource metadata file - no such file.", and start none of the resources it downloaded. FiveLab starts none of them, but goes on.`,
    ])
  })

  it('have the files that their server packed as they started, with those its scripts wrote', async () => {
    const { server, session } = await serverWithSession()
    server
      .add('a', {
        'fxmanifest.lua': manifest(
          `client_script 'client.lua'`,
          `server_script 'server.lua'`,
          `file 'data.txt'`,
        ),
        'client.lua': `print(LoadResourceFile(GetCurrentResourceName(), 'data.txt'))`,
        'server.lua': `SaveResourceFile(GetCurrentResourceName(), 'data.txt', 'saved', -1)`,
      })
      .start()
    server.manager.files.write(
      'resources/a/client.lua',
      new TextEncoder().encode(`print('changed')`),
    )
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    expect(scripts(client)).toEqual(['[script:a] saved'])
  })

  it('read the manifests that their server packed, though it read others', async () => {
    const { server, session } = await serverWithSession()
    const legacy = server.add('legacy', {
      '__resource.lua': `client_script 'client.lua'`,
      'client.lua': `print('legacy')`,
    })
    // Servers read manifests as they scan resources, but pack them as the resources start.
    server.manager.files.write('resources/legacy/__resource.lua', new Uint8Array())
    legacy.start()
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    expect([client.manager.getResource('legacy')!.state, scripts(client)]).toEqual(['started', []])
  })

  it('tell clients of no resource that is server_only', async () => {
    const { server, session } = await serverWithSession()
    const only = server.add('only', printing('only', `server_only 'yes'`))
    const client = await createProcess({ side: 'client' })
    join(session, client.manager)
    load(client)
    client.take()
    only.start()
    only.stop()
    load(client)
    expect(client.take()).toEqual([])
  })

  it('say when clients fail to load or start them, as FiveM stops with an error', async () => {
    const { server, session } = await serverWithSession()
    server.add('only', { 'fxmanifest.lua': manifest(`server_only 'yes'`) }).start()
    server.add('needs', printing('needs', `dependency 'only'`)).start()
    // Servers read manifests as they scan resources, but pack them as the resources start.
    const broken = ['broken', 'also'].map((name) => server.add(name, printing(name)))
    const write = (text: string) => {
      for (const { name } of broken) {
        server.manager.files.write(
          `resources/${name}/fxmanifest.lua`,
          new TextEncoder().encode(text),
        )
      }
    }
    write('= =')
    for (const resource of broken) resource.start()
    const first = await createProcess({ side: 'client' })
    join(session, first.manager)
    load(first)
    // FiveM's client stops at the first.
    expect(first.diagnostics).toEqual([
      `broken: FiveM's client would stop with the error "Couldn't load resource broken: Could not parse resource metadata file resources:/broken//fxmanifest.lua: /fxmanifest.lua:1: unexpected symbol near '='", and start none of the resources it downloaded. FiveLab starts none of them, but goes on.`,
    ])
    write(manifest())
    for (const resource of broken) {
      resource.stop()
      resource.start()
    }
    const second = await createProcess({ side: 'client' })
    join(session, second.manager)
    load(second)
    expect(second.diagnostics).toEqual([
      `needs: FiveM's client would stop with the error "Couldn't start resource needs.", which FiveLab does not emulate: it goes on.`,
    ])
  })
})
