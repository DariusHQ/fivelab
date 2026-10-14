import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  curlError,
  curlHeaders,
  fetchHttpClient,
  rewriteNucleusUrl,
  type HttpClient,
  type HttpFailure,
  type HttpRequest,
  type HttpResponse,
} from '../../src/core/engine/index.ts'
import { fetchFailure } from '../../src/core/engine/http.ts'
import { createProcess, runCommand, startResource } from './helpers.ts'

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text)

/** Lets the promises of HTTP clients settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A client that answers requests as `respond` says, and keeps them. */
function recorder(respond: (request: HttpRequest) => HttpResponse | HttpFailure = () => ok()): {
  requests: HttpRequest[]
  client: HttpClient
} {
  const requests: HttpRequest[] = []
  const client: HttpClient = (request) => {
    requests.push(request)
    return Promise.resolve(respond(request))
  }
  return { requests, client }
}

function ok(body = '', headers: HttpResponse['headers'] = []): HttpResponse {
  return { status: 200, headers, body: bytes(body) }
}

/** A Lua callback of PerformHttpRequest that prints what it gets, with the headers by name. */
const SHOW = `local function show(status, body, headers, errorData)
    local names = {}
    for name in pairs(headers) do names[#names + 1] = name end
    table.sort(names)
    local parts = {}
    for _, name in ipairs(names) do
        local value = headers[name]
        parts[#parts + 1] = name .. '=' .. (type(value) == 'table' and '[' .. table.concat(value, ',') .. ']' or value)
    end
    print(status, body, table.concat(parts, ';'), errorData)
end
`

/** The request that curl sends for a GET of `url` by PerformHttpRequest. */
function get(url: string, followLocation = true): HttpRequest {
  return {
    method: 'GET',
    url,
    headers: [
      ['User-Agent', 'FXServer/PerformHttpRequest'],
      ['Accept', '*/*'],
    ],
    body: new Uint8Array(),
    followLocation,
    timeout: 5000,
  }
}

function nativeErrors(resource: string, message: string): string[] {
  const error = `native 000000006b171e87: ${message}`
  return [
    `[citizen-scripting-core] script error in ${error}`,
    `[script:${resource}] false\t${error}`,
  ]
}

describe('PerformHttpRequest', () => {
  it('sends requests as curl does, and gives the responses at the tick after they come', async () => {
    const { requests, client } = recorder(() =>
      ok('hi', [
        ['Content-Type', 'text/plain'],
        ['Set-Cookie', 'a=1'],
        ['set-cookie', 'b=2'],
        ['Set-Cookie', 'c=3'],
      ]),
    )
    const proc = await createProcess({ http: client })
    expect(
      startResource(proc, 'a', {
        'main.lua': `${SHOW}PerformHttpRequest('https://example.com/x', show)`,
      }),
    ).toEqual([])
    proc.manager.tick()
    await settle()
    expect(proc.take()).toEqual([])
    proc.manager.tick()
    expect([requests, proc.take()]).toEqual([
      [get('https://example.com/x')],
      ['[script:a] 200\thi\tContent-Type=text/plain;Set-Cookie=[a=1,c=3];set-cookie=b=2\tnil'],
    ])
  })

  it('sends bodies as forms unless told otherwise, the headers of scripts by name, and no blank ones', async () => {
    const { requests, client } = recorder()
    const proc = await createProcess({ http: client })
    startResource(proc, 'a', {
      'main.lua': `PerformHttpRequest('http://a/1', print, 'POST', 'x=1')
PerformHttpRequest('http://a/2', print, 'PUT', '{}', {
    ['X-B'] = 'b', ['user-agent'] = 'mine', ['Content-Type'] = 'application/json', Accept = ' \\t', ['X-A'] = 'a',
})
PerformHttpRequest('http://a/3', print, 'get', '', {}, { followLocation = false })`,
    })
    expect(requests).toEqual([
      {
        ...get('http://a/1'),
        method: 'POST',
        headers: [...get('').headers, ['Content-Type', 'application/x-www-form-urlencoded']],
        body: bytes('x=1'),
      },
      {
        ...get('http://a/2'),
        method: 'PUT',
        headers: [
          ['Content-Type', 'application/json'],
          ['X-A', 'a'],
          ['X-B', 'b'],
          ['user-agent', 'mine'],
        ],
        body: bytes('{}'),
      },
      { ...get('http://a/3', false), method: 'get' },
    ])
  })

  it('gives failures of curl and statuses from 400 as errors, with no body or headers', async () => {
    const responses: (HttpResponse | HttpFailure)[] = [
      { status: 404, headers: [['X', 'y']], body: bytes('not found') },
      { status: 400, headers: [], body: bytes('') },
      { status: 399, headers: [['Location', '/b']], body: bytes('moved') },
      { code: 7, message: "Failed to connect to a port 80 after 0 ms: Couldn't connect to server" },
      { code: 99, message: 'Odd' },
    ]
    const { client } = recorder(() => responses.shift()!)
    const proc = await createProcess({ http: client })
    startResource(proc, 'a', {
      'main.lua': `${SHOW}for _ = 1, 5 do PerformHttpRequest('http://a', show) end`,
    })
    await settle()
    proc.manager.tick()
    expect(proc.take()).toEqual([
      '[script:a] 404\tnil\t\tHTTP 404: not found',
      '[script:a] 400\tnil\t\tHTTP 400: ',
      '[script:a] 399\tmoved\tLocation=/b\tnil',
      "[script:a] 0\tnil\t\tFailed to connect to a port 80 after 0 ms: Couldn't connect to server - CURL error code 7 (Couldn't connect to server)",
      '[script:a] 0\tnil\t\tOdd - CURL error code 99 (Unknown error)',
    ])
  })

  it('gives the bytes of bodies as they are', async () => {
    const body = Uint8Array.of(0, 0xff, 0x80)
    const { client } = recorder(() => ({ status: 500, headers: [], body }))
    const proc = await createProcess({ http: client })
    startResource(proc, 'a', {
      'main.lua': `PerformHttpRequest('http://a', function(_, _, _, errorData)
    print(errorData:byte(-3, -1))
end)`,
    })
    await settle()
    proc.manager.tick()
    expect(proc.take()).toEqual(['[script:a] 0\t255\t128'])
  })

  it('count tokens across resources, and give each its own responses alone', async () => {
    const { requests, client } = recorder()
    const proc = await createProcess({ http: client })
    const started = [
      startResource(proc, 'a', {
        'main.lua': `print(PerformHttpRequestInternalEx({ url = 'http://a', method = 'POST', data = '' }))`,
      }),
      startResource(proc, 'b', {
        'main.lua': `AddEventHandler('__cfx_internal:httpResponse', function(token, status, body, headers, errorData)
    print('got', token, status, body, next(headers), errorData)
end)
print(PerformHttpRequestInternalEx({ url = 'http://b', followLocation = true }))`,
      }),
    ]
    await settle()
    proc.manager.tick()
    expect([started, requests, proc.take()]).toEqual([
      [['[script:a] 0'], ['[script:b] 1']],
      [{ ...get('http://a', false), method: 'POST' }, get('http://b')],
      ['[script:b] got\t1\t200\t\tnil\tnil'],
    ])
  })

  it('give no response to resources that stopped', async () => {
    let respond = (_: HttpResponse) => {}
    const client: HttpClient = () => new Promise((resolve) => (respond = resolve))
    const proc = await createProcess({ http: client })
    startResource(proc, 'a', { 'main.lua': `PerformHttpRequest('http://a', print)` })
    proc.manager.getResource('a')!.stop()
    proc.take()
    respond(ok())
    await settle()
    proc.manager.tick()
    expect(proc.take()).toEqual([])
  })

  it('send what goes to the names of servers under users.cfx.re to the server itself, at its primary port', async () => {
    const { requests, client } = recorder()
    const proc = await createProcess({ http: client })
    const request = `PerformHttpRequest('https://me-abc123.users.cfx.re/a/b?c', print)`
    // Before the server takes an endpoint, it has no primary port.
    startResource(proc, 'a', { 'main.lua': request })
    runCommand(proc.manager, 'endpoint_add_tcp "0.0.0.0:30121"', 'system.console')
    startResource(proc, 'b', { 'main.lua': request })
    expect(requests.map(({ url }) => url)).toEqual([
      'http://localhost:0/a/b?c',
      'http://localhost:30121/a/b?c',
    ])
  })

  it('fail for requests of maps with fields of other types', async () => {
    const { requests, client } = recorder()
    const proc = await createProcess({ http: client })
    const calls = [
      '{ url = 1 }',
      '{ method = true }',
      '{ headers = { a = 1 } }',
      '{ data = 1 }',
      "{ followLocation = 'yes' }",
      "{ [1] = 'x', url = 'y' }",
    ]
    expect(
      startResource(proc, 'a', {
        'main.lua': [
          ...calls.map((call) => `print(pcall(PerformHttpRequestInternalEx, ${call}))`),
          `print(pcall(PerformHttpRequestInternalEx, 'x'))`,
          `print(pcall(PerformHttpRequestInternalEx, {}))`,
          `print(PerformHttpRequestInternalEx({ headers = { 'x' }, method = msgpack.null }))`,
        ].join('\n'),
      }),
    ).toEqual([
      ...calls.flatMap(() => nativeErrors('a', 'bad cast')),
      ...nativeErrors('a', 'invalid msgpack type'),
      // Lua packs empty tables as arrays.
      ...nativeErrors('a', 'invalid msgpack type'),
      '[script:a] 0',
    ])
    expect(requests).toEqual([get('', false)])
  })

  it('read maps as msgpack-c converts them: the last of duplicate keys, and strings of bin', async () => {
    const { requests, client } = recorder()
    const proc = await createProcess({ http: client })
    // A map of url = 'a', url = 'b' and data as bin 'x', which Lua does not pack.
    const map = [0x83, 0xa3, 0x75, 0x72, 0x6c, 0xa1, 0x61, 0xa3, 0x75, 0x72, 0x6c, 0xa1, 0x62]
    map.push(0xa4, 0x64, 0x61, 0x74, 0x61, 0xc4, 0x01, 0x78)
    expect(
      startResource(proc, 'a', {
        'main.lua': `local map = string.char(${map.join(', ')})
print(Citizen.InvokeNative(0x6b171e87, map, #map, Citizen.ResultAsInteger()))`,
      }),
    ).toEqual(['[script:a] 0'])
    expect(requests).toEqual([
      {
        ...get('b', false),
        headers: [...get('').headers, ['Content-Type', 'application/x-www-form-urlencoded']],
        body: bytes('x'),
      },
    ])
  })
})

describe('The headers of curl', () => {
  it('go before those of scripts, which replace them whatever their case', () => {
    expect(curlHeaders([['ACCEPT', 'text/html']], false)).toEqual([
      ['User-Agent', 'FXServer/PerformHttpRequest'],
      ['ACCEPT', 'text/html'],
    ])
    expect(curlHeaders([['content-TYPE', '']], true)).toEqual([
      ['User-Agent', 'FXServer/PerformHttpRequest'],
      ['Accept', '*/*'],
    ])
    expect(
      curlHeaders(
        [
          ['X', '\v\f\r\n x'],
          ['Y', '\v\f'],
        ],
        false,
      ),
    ).toEqual([
      ['User-Agent', 'FXServer/PerformHttpRequest'],
      ['Accept', '*/*'],
      ['X', '\v\f\r\n x'],
    ])
  })
})

describe('The URLs of the servers under users.cfx.re', () => {
  it('go to the server itself, as FiveM finds their hosts', () => {
    expect(
      [
        'https://a.users.cfx.re',
        'https://a.users.cfx.re:40120/x',
        'https://u@a.users.cfx.re/p',
        'https://.users.cfx.re/x',
        'https://a.users.cfx.re.example.com/x',
        'https://a.users.cfx.re?x',
        'abc.users.cfx.re/x',
        'https://a.example.com/b.users.cfx.re',
      ].map((url) => rewriteNucleusUrl(url, 30120)),
    ).toEqual([
      'http://localhost:30120',
      'http://localhost:30120/x',
      'http://localhost:30120/p',
      'https://.users.cfx.re/x',
      'https://a.users.cfx.re.example.com/x',
      'https://a.users.cfx.re?x',
      'abc.users.cfx.re/x',
      'https://a.example.com/b.users.cfx.re',
    ])
  })
})

describe('The failures of fetch', () => {
  const url = new URL('https://example.com/x')
  const failed = (code?: string, message = 'boom') =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })

  it('are those of curl that they stand for', () => {
    expect(
      [
        new DOMException('This operation was aborted', 'AbortError'),
        failed('ENOTFOUND'),
        failed('EAI_AGAIN'),
        failed('ECONNREFUSED'),
        failed('ECONNRESET'),
        failed('UND_ERR_SOCKET'),
        failed(undefined, 'odd'),
        new TypeError('fetch failed', { cause: 'text' }),
        new TypeError('fetch failed', { cause: null }),
        'thrown',
        null,
      ].map((error) => fetchFailure(error, url, 12)),
    ).toEqual([
      { code: 42, message: 'Callback aborted' },
      { code: 6, message: 'Could not resolve host: example.com' },
      { code: 6, message: 'Could not resolve host: example.com' },
      {
        code: 7,
        message:
          "Failed to connect to example.com port 443 after 12 ms: Couldn't connect to server",
      },
      { code: 56, message: 'Recv failure: Connection reset by peer' },
      { code: 52, message: 'Empty reply from server' },
      { code: 56, message: 'odd' },
      { code: 56, message: 'fetch failed' },
      { code: 56, message: 'fetch failed' },
      { code: 56, message: 'thrown' },
      { code: 56, message: 'null' },
    ])
    expect(
      ['http://a/', 'http://a:8080/'].map(
        (text) => fetchFailure(failed('ECONNREFUSED'), new URL(text), 0).message,
      ),
    ).toEqual([
      "Failed to connect to a port 80 after 0 ms: Couldn't connect to server",
      "Failed to connect to a port 8080 after 0 ms: Couldn't connect to server",
    ])
    expect(curlError({ code: 6, message: 'x' })).toBe(
      "x - CURL error code 6 (Couldn't resolve host name)",
    )
  })
})

describe('fetchHttpClient', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        switch (request.url) {
          case '/echo':
            response.setHeader('X-Method', request.method ?? '')
            response.setHeader('X-Agent', request.headers['user-agent'] ?? '')
            response.setHeader('X-Body', Buffer.concat(chunks).toString())
            response.setHeader('Set-Cookie', ['a=1', 'b=2'])
            response.end('hello')
            break
          case '/missing':
            response.statusCode = 404
            response.end('not found')
            break
          case '/moved':
            response.statusCode = 302
            response.setHeader('Location', '/echo')
            response.end('moved')
            break
          case '/trickle':
            // Node writes headers in UTF-8, which fetch reads as bytes.
            response.writeHead(200, { 'X-Name': `caf${String.fromCharCode(0xe9)}` })
            response.flushHeaders()
            setTimeout(() => response.end('done'), 100)
            break
          case '/close':
            request.socket.destroy()
            break
          case '/slow':
            break
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  const request = (path: string, change: Partial<HttpRequest> = {}): HttpRequest => ({
    ...get(`${base}${path}`),
    ...change,
  })

  /** A response by its status, the headers the server set, but those of the connection, and its body as text. */
  const summary = (result: HttpResponse | HttpFailure) => {
    if ('code' in result) return result
    const headers = result.headers.filter(
      ([name]) => name.startsWith('x-') || name === 'set-cookie' || name === 'location',
    )
    return [result.status, headers, new TextDecoder().decode(result.body)]
  }

  it('sends requests and gives the responses, with the names of headers in lower case', async () => {
    const response = await fetchHttpClient(
      request('/echo', {
        method: 'POST',
        body: bytes('x=1'),
        headers: [['User-Agent', 'FXServer/PerformHttpRequest']],
      }),
    )
    expect(summary(response)).toEqual([
      200,
      [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
        ['x-agent', 'FXServer/PerformHttpRequest'],
        ['x-body', 'x=1'],
        ['x-method', 'POST'],
      ],
      'hello',
    ])
  })

  it('sends no body with GET, guesses http without a scheme, and gives statuses as they are', async () => {
    const results = await Promise.all([
      fetchHttpClient(request('/echo', { body: bytes('x'), headers: [] })),
      fetchHttpClient({ ...request('/missing'), url: `${base.slice('http://'.length)}/missing` }),
    ])
    expect(results.map(summary)).toEqual([
      [
        200,
        [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
          ['x-agent', 'node'],
          ['x-body', ''],
          ['x-method', 'GET'],
        ],
        'hello',
      ],
      [404, [], 'not found'],
    ])
  })

  it('sends no body with methods that fetch takes as GET or HEAD', async () => {
    const results = await Promise.all(
      ['get', 'HEAD'].map((method) =>
        fetchHttpClient(request('/echo', { method, body: bytes('x'), headers: [] })),
      ),
    )
    expect(results.map((result) => summary(result))).toEqual(
      ['GET', 'HEAD'].map((method) => [
        200,
        [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
          ['x-agent', 'node'],
          ['x-body', ''],
          ['x-method', method],
        ],
        method === 'GET' ? 'hello' : '',
      ]),
    )
  })

  it('waits for the response to start alone, and gives the bytes of headers as UTF-8', async () => {
    const response = await fetchHttpClient(request('/trickle', { timeout: 50 }))
    expect(summary(response)).toEqual([
      200,
      [['x-name', `caf${String.fromCharCode(0xe9)}`]],
      'done',
    ])
  })

  it('follows redirects, unless told not to', async () => {
    const results = await Promise.all([
      fetchHttpClient(request('/moved')),
      fetchHttpClient(request('/moved', { followLocation: false })),
    ])
    expect(results.map(summary)).toEqual([
      [
        200,
        [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
          ['x-agent', 'FXServer/PerformHttpRequest'],
          ['x-body', ''],
          ['x-method', 'GET'],
        ],
        'hello',
      ],
      [302, [['location', '/echo']], 'moved'],
    ])
  })

  it('fails as curl does', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    const failures = await Promise.all([
      fetchHttpClient(request('/slow', { timeout: 50 })),
      fetchHttpClient(request('/close')),
      fetchHttpClient({ ...request(''), url: 'http://a b' }),
      fetchHttpClient({ ...request(''), url: 'ftp://a/b' }),
      ...['http', 'https'].map((scheme) =>
        fetchHttpClient({ ...request(''), url: `${scheme}://127.0.0.1:${port}/` }),
      ),
    ])
    // Windows takes its time to refuse connections.
    const refused = {
      code: 7,
      message: expect.stringMatching(
        new RegExp(
          `^Failed to connect to 127\\.0\\.0\\.1 port ${port} after \\d{1,5} ms: Couldn't connect to server$`,
        ),
      ),
    }
    expect(failures).toEqual([
      { code: 42, message: 'Callback aborted' },
      { code: 52, message: 'Empty reply from server' },
      { code: 3, message: 'URL rejected: Malformed input to a URL function' },
      { code: 1, message: 'Protocol "ftp" not supported' },
      refused,
      refused,
    ])
  })
})
