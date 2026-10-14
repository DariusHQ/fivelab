import { compareUtf8 } from '../../libc.ts'
import { defineNative, NativeError, type NativeDefinition } from '../../natives/index.ts'
import type { NativeContext } from '../context.ts'
import {
  curlError,
  curlHeaders,
  HTTP_TIMEOUT,
  rewriteNucleusUrl,
  type HttpFailure,
  type HttpHeader,
  type HttpRequest,
  type HttpResponse,
} from '../http.ts'
import { packObject, stringOf, unpackObject, type MsgpackObject } from '../msgpack.ts'
import { checkArgument } from './events.ts'

const encoder = new TextEncoder()

/** The event that gives scripts what their requests got. */
const RESPONSE_EVENT = '__cfx_internal:httpResponse'

/** What msgpack-c throws for a value of another type, as MSVC names it. */
function badCast(): NativeError {
  return new NativeError('bad cast')
}

/** A string, as msgpack-c converts str and bin to one, and fails for others. */
function text(object: MsgpackObject): string {
  const value = stringOf(object)
  if (value === undefined) throw badCast()
  return value
}

/** A msgpack map, as msgpack-c converts one to a std::map with keys of strings: the last of duplicates wins. */
function stringKeys(object: MsgpackObject & { type: 'map' }): Map<string, MsgpackObject> {
  const map = new Map<string, MsgpackObject>()
  for (const [key, value] of object.entries) map.set(text(key), value)
  return map
}

/**
 * The request that a script's map describes, as FiveM's server reads it:
 * a method, GET by default, headers when they are a map, as Lua makes
 * empty tables arrays, a URL, a body and whether to follow redirects, not
 * by default. Fields that are nil are as good as missing, and those of
 * another type fail the call. URLs to the server's own name go to `port`.
 */
function readRequest(data: Uint8Array, port: number): HttpRequest {
  const object = unpackObject(data)
  if (object.type !== 'map') throw new NativeError('invalid msgpack type')
  const fields = stringKeys(object)
  const field = (name: string) => {
    const value = fields.get(name)
    return value === undefined || value.type === 'nil' ? undefined : value
  }
  const method = field('method')
  const given = fields.get('headers')
  const headers: HttpHeader[] = []
  if (given?.type === 'map') {
    for (const [name, value] of stringKeys(given)) headers.push([name, text(value)])
    headers.sort(([a], [b]) => compareUtf8(a, b))
  }
  const url = field('url')
  const body = field('data')
  if (body !== undefined && body.type !== 'str' && body.type !== 'bin') throw badCast()
  const followLocation = field('followLocation')
  if (followLocation !== undefined && followLocation.type !== 'boolean') throw badCast()
  const bytes = body?.bytes ?? new Uint8Array()
  return {
    method: method === undefined ? 'GET' : text(method),
    url: rewriteNucleusUrl(url === undefined ? '' : text(url), port),
    headers: curlHeaders(headers, bytes.length > 0),
    body: bytes,
    followLocation: followLocation?.value ?? false,
    timeout: HTTP_TIMEOUT,
  }
}

function str(bytes: Uint8Array): MsgpackObject {
  return { type: 'str', bytes }
}

function int(value: number): MsgpackObject {
  return { type: 'positive', value: BigInt(value) }
}

const NIL: MsgpackObject = { type: 'nil' }
const NO_HEADERS: MsgpackObject = { type: 'map', entries: [] }

/** The headers of a response, by name in the order of their bytes: a string for one, an array for more. */
function headerMap(headers: readonly HttpHeader[]): MsgpackObject {
  const values = new Map<string, string[]>()
  for (const [name, value] of headers) {
    const list = values.get(name)
    if (list === undefined) values.set(name, [value])
    else list.push(value)
  }
  const names = [...values.keys()].sort(compareUtf8)
  return {
    type: 'map',
    entries: names.map((name) => {
      const list = values.get(name)!.map((value) => str(encoder.encode(value)))
      return [
        str(encoder.encode(name)),
        list.length === 1 ? list[0]! : { type: 'array', items: list },
      ]
    }),
  }
}

/**
 * The arguments of the event of a response: the token of the request, the
 * status, and the body and headers, or for a failure, of curl or a status
 * from 400, no body, no headers and the error, which for a status holds
 * the body.
 */
function responseArgs(token: number, result: HttpResponse | HttpFailure): Uint8Array {
  let args: MsgpackObject[]
  if ('code' in result) {
    args = [int(token), int(0), NIL, NO_HEADERS, str(encoder.encode(curlError(result)))]
  } else if (result.status >= 400) {
    const prefix = encoder.encode(`HTTP ${result.status}: `)
    const error = new Uint8Array(prefix.length + result.body.length)
    error.set(prefix)
    error.set(result.body, prefix.length)
    args = [int(token), int(result.status), NIL, NO_HEADERS, str(error)]
  } else {
    args = [int(token), int(result.status), str(result.body), headerMap(result.headers), NIL]
  }
  return packObject({ type: 'array', items: args })
}

/** Natives of FiveM's server for the HTTP requests of scripts, and those of its own HTTP server. */
export function httpNatives(): NativeDefinition<NativeContext>[] {
  /** The token of the next request, counted across the resources of the process, as FiveM does from 0. */
  let nextToken = 0
  return [
    defineNative(
      {
        name: 'PERFORM_HTTP_REQUEST_INTERNAL_EX',
        result: 'int',
        params: ['object requestData'],
      },
      (ctx: NativeContext, requestData) => {
        const { manager, resource } = ctx
        const request = readRequest(checkArgument(requestData, 0), manager.primaryPort)
        const token = nextToken++
        // FiveM queues the response for the resource alone, which gets it at the next tick.
        void manager.http(request).then((result) => {
          manager.events.queue(RESPONSE_EVENT, responseArgs(token, result), '', resource)
        })
        return token
      },
    ),
    defineNative(
      { name: 'SET_HTTP_HANDLER', result: 'void', params: ['func handler'] },
      (ctx: NativeContext, handler) => {
        // FiveM keeps the reference as it is, without holding the function.
        ctx.manager.httpServer?.setHandler(ctx.resource, checkArgument(handler, 0))
      },
    ),
  ]
}
