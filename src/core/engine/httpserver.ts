import { compareUtf8 } from '../libc.ts'
import { FIVEM_VERSION } from './constraints.ts'
import {
  argumentsOf,
  bytesArgument,
  ConversionError,
  intArgument,
  stringArgument,
  stringMapArgument,
} from './conversion.ts'
import type { HttpHeader } from './http.ts'
import type { ResourceManager } from './manager.ts'
import { packObject, type Extension, type MsgpackObject } from './msgpack.ts'
import type { Resource } from './resource.ts'

/** A request that a client sends the HTTP server of a server. */
export interface HttpServerRequest {
  readonly method: string
  /** The target of its request line: the path, with the query. */
  readonly path: string
  /** The headers, as they came. */
  readonly headers: readonly HttpHeader[]
  readonly body: Uint8Array
  /** The address of the client, as FiveM gives it to handlers: its IP and port. */
  readonly address: string
}

/**
 * What the client of a request gets, as FiveM's server writes the response
 * to a request of HTTP/1.1 to its connection, but the Date and Connection
 * headers: its head once, the data of what it writes, then its end. A
 * response that ends without a head sends nothing, as in FiveM, which
 * leaves the client waiting.
 */
export interface HttpServerSink {
  head(status: number, headers: readonly HttpHeader[]): void
  write(data: Uint8Array): void
  end(): void
}

/** A request that a server takes, which its client may give up on. */
export interface HttpServerExchange {
  /** Closes the connection of the request, as a client that goes away. */
  close(): void
}

/** What takes the requests to a prefix of paths, as FiveM's endpoints of its HTTP server. */
export type HttpEndpoint = (
  request: HttpServerRequest,
  response: HttpServerResponse,
  connection: Connection,
) => void

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Text in lower case, as FiveM lowers the letters of ASCII alone. */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** Compares the names of headers as FiveM's HeaderComparator does: in lower case. */
function compareNames(a: string, b: string): number {
  const x = lowerAscii(a)
  const y = lowerAscii(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Headers, as FiveM's HeaderMap keeps them: by name whatever its case, those of the same name as they came. */
export class HeaderMap {
  readonly #entries: HttpHeader[] = []

  get entries(): readonly HttpHeader[] {
    return this.#entries
  }

  /** The value of the first header named `name`, if any. */
  get(name: string): string | undefined {
    return this.#entries.find(([key]) => compareNames(key, name) === 0)?.[1]
  }

  /** Adds a header after those of the same name. */
  add(name: string, value: string): void {
    const after = this.#entries.findIndex(([key]) => compareNames(key, name) > 0)
    this.#entries.splice(after === -1 ? this.#entries.length : after, 0, [name, value])
  }

  /** Replaces the headers named `name` with one of each value, as FiveM's SetHeader does. */
  set(name: string, values: readonly string[]): void {
    this.delete(name)
    for (const value of values) this.add(name, value)
  }

  delete(name: string): void {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (compareNames(this.#entries[i]![0], name) === 0) this.#entries.splice(i, 1)
    }
  }
}

/** What runs as a connection closes, which lets go of what it holds if it goes without running. */
export interface CloseHandler {
  run(): void
  drop(): void
}

/** The connection of a request, as FiveM's server keeps it: until the client goes away. */
export class Connection implements HttpServerExchange {
  /** What runs as the connection closes, until the response ends, as FiveM's cancel handler. */
  #handler: CloseHandler | undefined
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  /** Sets what runs as the connection closes, or nothing, in place of what would have. */
  setCloseHandler(handler: CloseHandler | undefined): void {
    const old = this.#handler
    this.#handler = handler
    old?.drop()
  }

  close(): void {
    this.#closed = true
    const handler = this.#handler
    this.#handler = undefined
    handler?.run()
  }
}

/**
 * A response to a request, as FiveM's HTTP/1.1 server makes one: it
 * writes its head, with the status and headers it has then, as it first
 * writes, or as told to, and sends what it writes in chunks, unless the
 * headers say that it goes as it is, or the request asks rockstargames.com.
 * It ends nothing that it wrote no head of, which leaves the client
 * waiting for what it may still write. Once it ended, or the connection
 * closed, it sends nothing, where FiveM would write past the end.
 */
export class HttpServerResponse {
  status = 200
  readonly headers = new HeaderMap()
  readonly #host: string
  readonly #sink: HttpServerSink
  readonly #connection: Connection
  #sentHead = false
  #ended = false

  constructor(request: HeaderMap, sink: HttpServerSink, connection: Connection) {
    this.#host = request.get('host') ?? ''
    this.#sink = sink
    this.#connection = connection
  }

  /** Writes the head with `status`, unless it wrote it already. */
  writeHead(status: number): void {
    this.#writeHead(status, 0)
  }

  /** Writes data, after the head with the status it has, unless it wrote it already. */
  write(data: Uint8Array): void {
    this.#writeHead(this.status, data.length)
    // Nothing goes for no data, nor an empty chunk, which would end the body.
    if (data.length > 0 && this.#open) this.#sink.write(data)
  }

  /** Ends the response, after `data`, if given. The connection runs nothing as it closes from then on. */
  end(data?: Uint8Array): void {
    if (data !== undefined) this.write(data)
    this.#connection.setCloseHandler(undefined)
    if (!this.#sentHead) return
    if (this.#open) this.#sink.end()
    this.#ended = true
  }

  get #open(): boolean {
    return !this.#ended && !this.#connection.closed
  }

  /**
   * Writes the head, unless it wrote it already, once it chose how to send
   * the body, as FiveM chooses before it first writes: as it is when the
   * headers say identity, or the request goes to rockstargames.com, with
   * `length`, that of the data it writes first, unless the headers have
   * one, or else in chunks, without a length.
   */
  #writeHead(status: number, length: number): void {
    if (this.#sentHead) return
    const identity =
      this.#host.includes('rockstargames.com') ||
      (this.headers.get('transfer-encoding') ?? '').includes('identity')
    if (identity) {
      if (this.headers.get('content-length') === undefined) {
        this.headers.set('Content-Length', [String(length)])
      }
      this.headers.delete('transfer-encoding')
    } else {
      this.headers.set('Transfer-Encoding', ['chunked'])
      this.headers.delete('content-length')
    }
    this.#sentHead = true
    if (this.#open) this.#sink.head(status, [...this.headers.entries])
  }
}

/**
 * Whether a path goes to the endpoint of a prefix, as FiveM's HTTP server
 * finds them: "/" takes itself alone, and others the paths that start
 * with them, whatever the case, and the path they are without their last
 * slash.
 */
function matches(prefix: string, path: string): boolean {
  if (prefix === '/') return path === '/'
  if (lowerAscii(path.slice(0, prefix.length)) === lowerAscii(prefix)) return true
  return prefix.endsWith('/') && path === prefix.slice(0, -1)
}

function str(text: string | Uint8Array): MsgpackObject {
  return { type: 'str', bytes: typeof text === 'string' ? encoder.encode(text) : text }
}

function ext(extension: Extension): MsgpackObject {
  return { type: 'ext', extension }
}

/** The function that a msgpack value references, as FiveM takes the references of functions, of scripts or of its own code. */
function referenceOf(object: MsgpackObject | undefined): string | undefined {
  if (object?.type !== 'ext' || ![10, 11].includes(object.extension.type)) return undefined
  return decoder.decode(object.extension.data)
}

/**
 * The HTTP server of a server, as FiveM's HttpServerManager: endpoints by
 * prefix, which take the requests whose paths they match, the first in
 * the order of the bytes of their prefixes; "/" says which version the
 * server runs, and each resource that runs takes those to its name, which
 * the handler that it sets gets.
 */
export class HttpServer {
  readonly #manager: ResourceManager
  readonly #endpoints = new Map<string, HttpEndpoint>()
  /** The references to the handlers of the resources, which they keep as they restart, as FiveM does. */
  readonly #handlers = new Map<Resource, string>()

  constructor(manager: ResourceManager) {
    this.#manager = manager
    this.add('/', (_request, response) => this.#describe(response))
  }

  /** Adds an endpoint, unless one has its prefix. */
  add(prefix: string, endpoint: HttpEndpoint): void {
    if (!this.#endpoints.has(prefix)) this.#endpoints.set(prefix, endpoint)
  }

  remove(prefix: string): void {
    this.#endpoints.delete(prefix)
  }

  /** Takes a request, which goes to the endpoint it matches, now. Writes to the connection go to `sink`. */
  request(request: HttpServerRequest, sink: HttpServerSink): HttpServerExchange {
    const connection = new Connection()
    const headers = new HeaderMap()
    for (const [name, value] of request.headers) headers.add(name, value)
    const response = new HttpServerResponse(headers, sink, connection)
    const prefixes = [...this.#endpoints.keys()].sort(compareUtf8)
    const prefix = prefixes.find((candidate) => matches(candidate, request.path))
    if (prefix === undefined) {
      response.status = 404
      response.end(encoder.encode(`Route ${request.path} not found.`))
    } else {
      this.#endpoints.get(prefix)!(request, response, connection)
    }
    return connection
  }

  /** Sets the handler of a resource, as SetHttpHandler does. */
  setHandler(resource: Resource, ref: string): void {
    this.#handlers.set(resource, ref)
  }

  /**
   * Gives a resource the endpoint of its name as it starts, after its
   * scripts loaded, and takes it as it stops, as FiveM does: but for the
   * resource monitor while monitorMode is not 0, whose endpoint has no
   * prefix, which goes first and takes all requests, for good.
   */
  attach(resource: Resource): void {
    let prefix = ''
    resource.onStart.connect(() => {
      const monitorMode = this.#manager.console.variables.find('monitorMode')?.value
      const monitor =
        monitorMode !== undefined && monitorMode !== '0' && resource.name === 'monitor'
      prefix = monitor ? '' : `/${resource.name}/`
      this.add(prefix, (request, response, connection) =>
        this.#serve(resource, prefix, request, response, connection),
      )
    }, 9999)
    resource.onStop.connect(() => {
      if (prefix !== '') this.remove(prefix)
    }, -9999)
  }

  /** What "/" says: where to join a server that has a name under users.cfx.re, or its version. */
  #describe(response: HttpServerResponse): void {
    const baseUrl = this.#manager.console.variables.find('web_baseUrl')?.value ?? ''
    const end = baseUrl.indexOf('.users.cfx.re')
    const start = end === -1 ? -1 : baseUrl.lastIndexOf('-', end)
    if (start !== -1) {
      response.status = 302
      response.headers.set('Location', [`https://cfx.re/join/${baseUrl.slice(start + 1, end)}`])
      response.end(encoder.encode('Redirecting...'))
      return
    }
    response.end(encoder.encode(JSON.stringify({ version: FIVEM_VERSION })))
  }

  /**
   * Gives a request to the handler of a resource at the next tick, as
   * FiveM's server gives the requests that its network thread takes to
   * its main one, with the path past the prefix, or says that the
   * resource has none.
   */
  #serve(
    resource: Resource,
    prefix: string,
    request: HttpServerRequest,
    response: HttpServerResponse,
    connection: Connection,
  ): void {
    if (!this.#handlers.has(resource)) {
      response.status = 404
      response.headers.set('Content-Type', ['text/plain; charset=utf-8'])
      response.end(encoder.encode('Not found.'))
      return
    }
    const length = prefix.endsWith('/') ? prefix.length : prefix.length + 1
    const path = `/${request.path.slice(length)}`
    this.#manager.receive(() => this.#callHandler(resource, request, path, response, connection))
  }

  #callHandler(
    resource: Resource,
    request: HttpServerRequest,
    path: string,
    response: HttpServerResponse,
    connection: Connection,
  ): void {
    const manager = this.#manager
    // Headers go to scripts by name, the first of each.
    const headers = new Map<string, string>()
    for (const [name, value] of request.headers) if (!headers.has(name)) headers.set(name, value)
    const names = [...headers.keys()].sort(compareUtf8)
    let pending: Uint8Array | undefined = request.body.length > 0 ? request.body : undefined
    const requestMap: MsgpackObject = {
      type: 'map',
      entries: [
        [
          str('headers'),
          { type: 'map', entries: names.map((name) => [str(name), str(headers.get(name)!)]) },
        ],
        [str('method'), str(request.method)],
        [str('address'), str(request.address)],
        [str('path'), str(path)],
        [
          str('setDataHandler'),
          callback(manager, 'request.setDataHandler', (args) => {
            const ref = referenceOf(args[0])
            // FiveM gives the body as binary when told to, which Lua takes as a string all the same.
            if (args.length > 1) stringArgument(args[1]!)
            // A body that came goes to the handler at once. FiveRunner's requests come whole,
            // so no body is still to come.
            if (ref === undefined || pending === undefined) return
            const body = pending
            pending = undefined
            manager.duplicateFunctionReference(ref)
            manager.invokeFunctionReference(ref, packObject({ type: 'array', items: [str(body)] }))
            manager.deleteFunctionReference(ref)
          }),
        ],
        [
          str('setCancelHandler'),
          callback(manager, 'request.setCancelHandler', (args) => {
            const ref = referenceOf(args[0])
            if (ref === undefined) return
            manager.duplicateFunctionReference(ref)
            connection.setCloseHandler({
              // The network thread of FiveM's server has the main one call the handler.
              run: () =>
                manager.receive(() => {
                  manager.invokeFunctionReference(ref, packObject({ type: 'array', items: [] }))
                  manager.deleteFunctionReference(ref)
                }),
              drop: () => manager.deleteFunctionReference(ref),
            })
          }),
        ],
      ],
    }
    const responseMap: MsgpackObject = {
      type: 'map',
      entries: [
        [
          str('write'),
          callback(manager, 'response.write', (args) =>
            response.write(bytesArgument(args[0] ?? NIL)),
          ),
        ],
        [
          str('writeHead'),
          callback(manager, 'response.writeHead', (args) => {
            if (args.length !== 1) {
              for (const [name, value] of stringMapArgument(args[1] ?? NIL)) {
                const values = value.type === 'array' ? value.items : [value]
                response.headers.set(name, values.map(stringArgument))
              }
            }
            response.status = intArgument(args[0] ?? NIL)
            response.writeHead(response.status)
          }),
        ],
        [
          str('send'),
          callback(manager, 'response.send', (args) => {
            response.end(args.length === 0 ? undefined : bytesArgument(args[0]!))
          }),
        ],
      ],
    }
    const ref = this.#handlers.get(resource)!
    manager.invokeFunctionReference(
      ref,
      packObject({ type: 'array', items: [requestMap, responseMap] }),
    )
  }
}

const NIL: MsgpackObject = { type: 'nil' }

/**
 * A function of a request, as a reference to a callback, which reports the
 * arguments it fails to convert, where FiveM throws.
 */
function callback(
  manager: ResourceManager,
  name: string,
  fn: (args: readonly MsgpackObject[]) => void,
): MsgpackObject {
  return ext(
    manager.callbacks.create((args) => {
      try {
        fn(argumentsOf(args))
      } catch (error) {
        if (!(error instanceof ConversionError)) throw error
        manager.output.diagnose(
          manager.currentResource?.name ?? '',
          `${name} was given ${error.message}: msgpack throws then, which FiveRunner does not emulate, and it ignores the rest of the call.`,
        )
      }
    }),
  )
}
