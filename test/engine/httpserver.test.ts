import { describe, expect, it } from 'vitest'

import type { HttpEndpoint, HttpServerRequest } from '../../src/core/engine/index.ts'
import { createProcess, runCommand, startResource, type TestProcess } from './helpers.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A request to a server as a client sends it, which records what the client gets, as lines. */
function send(proc: TestProcess, path: string, change: Partial<HttpServerRequest> = {}) {
  const got: string[] = []
  const exchange = proc.manager.httpServer!.request(
    {
      method: 'GET',
      path,
      headers: [],
      body: new Uint8Array(),
      address: '127.0.0.1:50000',
      ...change,
    },
    {
      head: (status, headers) =>
        got.push(`head ${status}${headers.map(([name, value]) => ` ${name}=${value}`).join('')}`),
      write: (data) => got.push(`write ${decoder.decode(data)}`),
      end: () => got.push('end'),
    },
  )
  return { got, exchange }
}

/** What a client gets for a body sent in chunks, as FiveM sends them, with the headers of its head. */
function chunked(status: number, body: string, head = ' Transfer-Encoding=chunked'): string[] {
  return [`head ${status}${head}`, `write ${body}`, 'end']
}

/** A resource whose handler runs `lua` with request and response. */
function handler(proc: TestProcess, name: string, lua: string): string[] {
  return startResource(proc, name, {
    'main.lua': `SetHttpHandler(function(request, response)
${lua}
end)`,
  })
}

describe('The HTTP server of a server', () => {
  it('says its version at /, or where to join it under users.cfx.re, and that other routes are not found', async () => {
    const proc = await createProcess()
    const version = send(proc, '/').got
    const missing = ['/x', '', '/X/'].map((path) => send(proc, path).got)
    runCommand(proc.manager, 'set web_baseUrl me-abc123.users.cfx.re', 'system.console')
    const joined = send(proc, '/').got
    // Names without a dash before users.cfx.re, or without it, say no more than the version.
    const described = ['abc123.users.cfx.re', '-abc123'].map((url) => {
      runCommand(proc.manager, `set web_baseUrl ${url}`, 'system.console')
      return send(proc, '/').got
    })
    const versionJson = chunked(200, '{"version":"FXServer-master SERVER v1.0.0.37175 win32"}')
    expect([version, missing, joined, described]).toEqual([
      versionJson,
      [
        chunked(404, 'Route /x not found.'),
        chunked(404, 'Route  not found.'),
        chunked(404, 'Route /X/ not found.'),
      ],
      chunked(
        302,
        'Redirecting...',
        ' Location=https://cfx.re/join/abc123 Transfer-Encoding=chunked',
      ),
      [versionJson, versionJson],
    ])
  })

  it('is that of servers alone', async () => {
    const client = await createProcess({ side: 'client' })
    expect(client.manager.httpServer).toBeUndefined()
  })

  it('gives resources the requests to their names, whatever the case, at the next tick', async () => {
    const proc = await createProcess()
    handler(
      proc,
      'zapi',
      `print(request.method, request.path, request.address)
response.writeHead(201, { ['X-A'] = 'a', ['set-cookie'] = { 'a=1', 'b=2' } })
response.send('done')`,
    )
    const requests = ['/zapi/x?y=1', '/ZAPI/', '/zapi'].map((path) =>
      send(proc, path, { method: 'POST' }),
    )
    const early = requests.map(({ got }) => [...got])
    proc.manager.tick()
    expect([early, requests.map(({ got }) => got), proc.take()]).toEqual([
      [[], [], []],
      // Headers go by name whatever its case.
      requests.map(() =>
        chunked(201, 'done', ' set-cookie=a=1 set-cookie=b=2 Transfer-Encoding=chunked X-A=a'),
      ),
      [
        '[script:zapi] POST\t/x?y=1\t127.0.0.1:50000',
        '[script:zapi] POST\t/\t127.0.0.1:50000',
        '[script:zapi] POST\t/\t127.0.0.1:50000',
      ],
    ])
    expect(['/zapix', '/ZAPI'].map((path) => send(proc, path).got)).toEqual([
      chunked(404, 'Route /zapix not found.'),
      chunked(404, 'Route /ZAPI not found.'),
    ])
  })

  it('routes requests to the endpoints that embedders add, as FiveM matches their prefixes', async () => {
    const proc = await createProcess()
    const server = proc.manager.httpServer!
    const endpoint =
      (body: string): HttpEndpoint =>
      (_, response) =>
        response.end(encoder.encode(body))
    server.add('/info.json', endpoint('info'))
    server.add('/info.json', endpoint('again'))
    server.add('/files/', endpoint('files'))
    const paths = ['/INFO.JSON', '/info.json?x', '/info.jso', '/files', '/FILES/a']
    const before = paths.map((path) => send(proc, path).got)
    server.remove('/info.json')
    expect([before, send(proc, '/info.json').got]).toEqual([
      [
        chunked(200, 'info'),
        chunked(200, 'info'),
        chunked(404, 'Route /info.jso not found.'),
        chunked(200, 'files'),
        chunked(200, 'files'),
      ],
      chunked(404, 'Route /info.json not found.'),
    ])
  })

  it('gives sinks heads that stay as they were written', async () => {
    const proc = await createProcess()
    handler(proc, 'api', `response.write('a') response.writeHead(500, { ['X-Late'] = 'yes' })`)
    const heads: (readonly (readonly [string, string])[])[] = []
    proc.manager.httpServer!.request(
      { method: 'GET', path: '/api/', headers: [], body: new Uint8Array(), address: '' },
      { head: (_, headers) => heads.push(headers), write: () => {}, end: () => {} },
    )
    proc.manager.tick()
    expect(heads).toEqual([[['Transfer-Encoding', 'chunked']]])
  })

  it('give requests to resources without handlers, which are not found, until they stop', async () => {
    const proc = await createProcess()
    startResource(proc, 'quiet', { 'main.lua': '' })
    const found = send(proc, '/quiet/x').got
    proc.manager.getResource('quiet')!.stop()
    expect([found, send(proc, '/quiet/x').got]).toEqual([
      [
        'head 404 Content-Type=text/plain; charset=utf-8 Transfer-Encoding=chunked',
        'write Not found.',
        'end',
      ],
      chunked(404, 'Route /quiet/x not found.'),
    ])
  })

  it('keeps the handlers of resources as they restart, which then get no request', async () => {
    const proc = await createProcess()
    runCommand(proc.manager, 'set serve yes', 'system.console')
    startResource(proc, 'api', {
      'main.lua': `if GetConvar('serve', '') == 'yes' then
    SetHttpHandler(function(_, response) response.send('served') end)
end`,
    })
    const served = send(proc, '/api/')
    proc.manager.tick()
    runCommand(proc.manager, 'set serve no', 'system.console')
    const resource = proc.manager.getResource('api')!
    resource.stop()
    resource.start()
    proc.take()
    const { got } = send(proc, '/api/')
    proc.manager.tick()
    expect([served.got, got, proc.take()]).toEqual([chunked(200, 'served'), [], []])
  })

  it('gives handlers the headers of requests by name, the first of each', async () => {
    const proc = await createProcess()
    handler(
      proc,
      'api',
      `local names = {}
for name, value in pairs(request.headers) do names[#names + 1] = name .. '=' .. value end
table.sort(names)
print(table.concat(names, ' '))`,
    )
    send(proc, '/api/', {
      headers: [
        ['X-A', '1'],
        ['x-a', '2'],
        ['B', '3'],
        ['X-A', '4'],
      ],
    })
    proc.manager.tick()
    expect(proc.take()).toEqual(['[script:api] B=3 X-A=1 x-a=2'])
  })

  it('gives data handlers the bodies of requests at once, and none for requests without one', async () => {
    const proc = await createProcess()
    handler(
      proc,
      'api',
      `-- What is no function sets no handler, and leaves the body for the next.
request.setDataHandler('x')
request.setCancelHandler(1)
request.setDataHandler(function(body) print('body', request.method, body) end, 'binary')
request.setDataHandler(function(body) print('again', body) end)
print('set', request.method)`,
    )
    send(proc, '/api/', { method: 'POST', body: encoder.encode('x=1') })
    send(proc, '/api/')
    proc.manager.tick()
    expect([proc.take(), proc.diagnostics]).toEqual([
      ['[script:api] body\tPOST\tx=1', '[script:api] set\tPOST', '[script:api] set\tGET'],
      [],
    ])
  })

  it('give bodies to the functions of FiveM that are data handlers too', async () => {
    const proc = await createProcess()
    handler(proc, 'api', `request.setDataHandler(response.send)`)
    const { got } = send(proc, '/api/', { method: 'POST', body: encoder.encode('echo') })
    proc.manager.tick()
    expect(got).toEqual(chunked(200, 'echo'))
  })

  it('write heads once, as they first write, and end nothing they wrote no head of', async () => {
    const proc = await createProcess()
    handler(
      proc,
      'api',
      `if request.path == '/write' then
    response.write('a')
    response.writeHead(500, { ['X-Late'] = 'yes' })
    response.write('')
    response.send('b')
    response.send('c')
elseif request.path == '/late' then
    response.send()
    response.send('late')
elseif request.path == '/length' then
    response.writeHead(200, { ['Content-Length'] = '9' })
    response.send()
elseif request.path == '/identity' then
    response.writeHead(204, { ['Transfer-Encoding'] = 'identity, gzip' })
    response.send('x')
elseif request.path == '/given' then
    response.writeHead(200, { ['transfer-encoding'] = 'identity', ['Content-Length'] = '1' })
    response.send('y')
elseif request.path == '/encoding' then
    response.writeHead(200, { ['transfer-encoding'] = 'gzip' })
    response.send('z')
elseif request.path == '/cases' then
    -- Headers are set by name in the order of their bytes, and replace those of the same name whatever its case.
    response.writeHead(200, { A = '1', a = '2', b = '3', B = '4' })
    response.send('')
elseif request.path == '/negative' then
    response.writeHead(-5)
    response.send('n')
elseif request.path == '/max' then
    response.writeHead(2147483647)
    response.send('')
elseif request.path == '/min' then
    response.writeHead(-2147483648)
    response.send('')
else
    response.send('abc')
end`,
    )
    const requests = [
      send(proc, '/api/write'),
      send(proc, '/api/late'),
      send(proc, '/api/length'),
      send(proc, '/api/identity'),
      send(proc, '/api/given'),
      send(proc, '/api/encoding'),
      send(proc, '/api/cases'),
      send(proc, '/api/negative'),
      send(proc, '/api/max'),
      send(proc, '/api/min'),
      send(proc, '/api/ros', { headers: [['Host', 'prod.ros.rockstargames.com']] }),
    ]
    proc.manager.tick()
    expect([requests.map(({ got }) => got), proc.diagnostics]).toEqual([
      [
        ['head 200 Transfer-Encoding=chunked', 'write a', 'write b', 'end'],
        chunked(200, 'late'),
        ['head 200 Transfer-Encoding=chunked', 'end'],
        ['head 204 Content-Length=0', 'write x', 'end'],
        ['head 200 Content-Length=1', 'write y', 'end'],
        chunked(200, 'z'),
        ['head 200 a=2 b=3 Transfer-Encoding=chunked', 'end'],
        chunked(-5, 'n'),
        ['head 2147483647 Transfer-Encoding=chunked', 'end'],
        ['head -2147483648 Transfer-Encoding=chunked', 'end'],
        ['head 200 Content-Length=3', 'write abc', 'end'],
      ],
      [],
    ])
  })

  it('run handlers of cancels at the next tick as clients go away, until responses end', async () => {
    const proc = await createProcess()
    handler(
      proc,
      'api',
      `request.setCancelHandler(function() print('first', request.path) end)
request.setCancelHandler(function() print('gone', request.path) end)
if request.path ~= '/open' then response.send('done') end`,
    )
    const requests = ['/api/open', '/api/done'].map((path) => send(proc, path))
    // A client that goes before its request is handled gets nothing of what the handler writes.
    const closed = send(proc, '/api/closed')
    closed.exchange.close()
    proc.manager.tick()
    for (const { exchange } of requests) {
      exchange.close()
      exchange.close()
    }
    const early = proc.take()
    proc.manager.tick()
    expect([early, proc.take(), requests.map(({ got }) => got), closed.got]).toEqual([
      [],
      ['[script:api] gone\t/open'],
      [[], chunked(200, 'done')],
      [],
    ])
  })

  it('converts what handlers give the functions of requests as msgpack-c does', async () => {
    const proc = await createProcess()
    handler(
      proc,
      'api',
      `request.setDataHandler(print, 1)
response.write(1)
response.writeHead(200.5)
response.writeHead(1 << 40)
response.writeHead(-2147483649)
response.writeHead(200, {})
response.writeHead(200, { [1] = 'x', a = 'y' })
response.writeHead(201, { a = 'b', b = 1 })
response.writeHead()
response.send(true)`,
    )
    const { got } = send(proc, '/api/')
    proc.manager.tick()
    const failed = (name: string, what: string) =>
      `api: ${name} was given ${what}: msgpack throws then, which FiveRunner does not emulate, and it ignores the rest of the call.`
    expect([got, proc.diagnostics]).toEqual([
      [],
      [
        failed('request.setDataHandler', 'an integer, which msgpack fails to convert to a string'),
        failed('response.write', 'an integer, which msgpack fails to convert to a string'),
        failed('response.writeHead', 'a float, which msgpack fails to convert to an int'),
        ...[1, 2].map(() =>
          failed(
            'response.writeHead',
            'an integer that an int does not hold, which msgpack fails to convert',
          ),
        ),
        failed('response.writeHead', 'an array, which msgpack fails to convert to a map'),
        failed(
          'response.writeHead',
          'a map with an integer for a key, which msgpack fails to convert to a string',
        ),
        failed('response.writeHead', 'an integer, which msgpack fails to convert to a string'),
        failed('response.writeHead', 'nil, which msgpack fails to convert to a map'),
        failed('response.send', 'a boolean, which msgpack fails to convert to a string'),
      ],
    ])
  })

  it('gives the resource monitor the requests to its name alone without monitorMode', async () => {
    const proc = await createProcess()
    handler(proc, 'monitor', `response.send('m')`)
    const requests = ['/x', '/monitor/'].map((path) => send(proc, path).got)
    proc.manager.tick()
    expect(requests).toEqual([chunked(404, 'Route /x not found.'), chunked(200, 'm')])
  })

  it('gives the resource monitor all requests, for good, while monitorMode is not 0', async () => {
    const proc = await createProcess()
    runCommand(proc.manager, 'set monitorMode 1', 'system.console')
    // Resources that start before the monitor do not take all requests themselves.
    handler(proc, 'api', `response.send('api')`)
    handler(proc, 'monitor', `print(request.path) response.send('m')`)
    const requests = ['/', '/api/x', '/monitor/y'].map((path) => send(proc, path).got)
    proc.manager.tick()
    const paths = proc.take()
    // The resource stops, and its endpoint stays, with the handler it had.
    proc.manager.getResource('monitor')!.stop()
    proc.take()
    const stopped = send(proc, '/x').got
    proc.manager.tick()
    // Started again, it has the prefix of its name too, which the endpoint that stayed cuts paths by.
    runCommand(proc.manager, 'set monitorMode 0', 'system.console')
    proc.manager.getResource('monitor')!.start()
    proc.take()
    const started = ['/z', '/monitor/z'].map((path) => send(proc, path).got)
    proc.manager.tick()
    expect([requests, paths, stopped, started, proc.take()]).toEqual([
      [chunked(200, 'm'), chunked(200, 'm'), chunked(200, 'm')],
      ['[script:monitor] /', '[script:monitor] /api/x', '[script:monitor] /monitor/y'],
      [],
      [chunked(200, 'm'), chunked(200, 'm')],
      ['[script:monitor] /', '[script:monitor] /z'],
    ])
  })
})
