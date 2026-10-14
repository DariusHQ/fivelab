/** A header, by its name and value. */
export type HttpHeader = readonly [name: string, value: string]

/** A request of PerformHttpRequest, as FiveM's server has curl send it. */
export interface HttpRequest {
  /** The method, as the script gave it, which curl sends as it is. */
  readonly method: string
  readonly url: string
  /** The headers that curl sends, but those of the connection and the length of the body; see curlHeaders. */
  readonly headers: readonly HttpHeader[]
  /** The body, which curl sends whenever it is not empty, whatever the method. */
  readonly body: Uint8Array
  /** Whether redirects are followed, rather than given to the script. */
  readonly followLocation: boolean
  /**
   * The milliseconds within which a response must start, or FiveM's client
   * aborts the request: a failure of code 42, which curl's error buffer
   * reports as "Callback aborted".
   */
  readonly timeout: number
}

/** A response, with the headers of its last part, as they came. */
export interface HttpResponse {
  readonly status: number
  readonly headers: readonly HttpHeader[]
  readonly body: Uint8Array
}

/** A request that curl failed: its error code, and what its error buffer reports. */
export interface HttpFailure {
  readonly code: number
  readonly message: string
}

/**
 * Sends the HTTP requests of a server's scripts, as FiveM's server does
 * with curl. It resolves with what each got, rather than rejects.
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse | HttpFailure>

/** The user agent of FiveM's server for the requests of scripts. */
export const USER_AGENT = 'FXServer/PerformHttpRequest'

/** How long FiveM's server waits for responses to start. */
export const HTTP_TIMEOUT = 5000

/** What curl_easy_strerror says of the codes of the failures FiveLab knows. */
const CURL_ERRORS: Readonly<Record<number, string>> = {
  1: 'Unsupported protocol',
  3: 'URL using bad/illegal format or missing URL',
  6: "Couldn't resolve host name",
  7: "Couldn't connect to server",
  28: 'Timeout was reached',
  35: 'SSL connect error',
  42: 'Operation was aborted by an application callback',
  52: 'Server returned nothing (no headers, no data)',
  55: 'Failed sending data to the peer',
  56: 'Failure when receiving data from the peer',
}

/** The error of a failure, as FiveM's client reports those of curl. */
export function curlError({ code, message }: HttpFailure): string {
  return `${message} - CURL error code ${code} (${CURL_ERRORS[code] ?? 'Unknown error'})`
}

/** Whether a header value holds nothing but what C's isspace finds. */
function blank(value: string): boolean {
  return /^[\t\n\v\f\r ]*$/.test(value)
}

/**
 * The headers curl sends for the headers of a script, which come ordered
 * by name: its user agent and the types it accepts, then those of the
 * script, then the type of a body. A header of the script replaces curl's
 * of the same name, whatever its case, and one with a blank value is not
 * sent at all.
 */
export function curlHeaders(headers: readonly HttpHeader[], body: boolean): HttpHeader[] {
  const given = new Set(headers.map(([name]) => name.toLowerCase()))
  const sent: HttpHeader[] = []
  if (!given.has('user-agent')) sent.push(['User-Agent', USER_AGENT])
  if (!given.has('accept')) sent.push(['Accept', '*/*'])
  for (const header of headers) if (!blank(header[1])) sent.push(header)
  // curl sends a body as a form, unless told otherwise.
  if (body && !given.has('content-type')) {
    sent.push(['Content-Type', 'application/x-www-form-urlencoded'])
  }
  return sent
}

/** The port that FiveM's server listens on first, by default, which FiveLab gives as it listens nowhere. */
const PRIMARY_PORT = 30120

/** The hosts of FiveM's own servers, whose names end with it. */
const NUCLEUS_SUFFIX = '.users.cfx.re'

/**
 * The URL that FiveM's server sends a request to: one to its own name, a
 * host under users.cfx.re, goes to itself, on localhost. Like FiveM, it
 * takes the host to run from the scheme to the first slash, or the end,
 * and to stop there or at a colon.
 */
export function rewriteNucleusUrl(url: string): string {
  const scheme = url.indexOf('://')
  if (scheme === -1) return url
  const start = scheme + 3
  const slash = url.indexOf('/', start)
  const end = slash === -1 ? url.length : slash
  const authority = url.slice(start, end)
  const colon = authority.indexOf(':')
  const host = colon === -1 ? authority : authority.slice(0, colon)
  if (host.length <= NUCLEUS_SUFFIX.length || !host.endsWith(NUCLEUS_SUFFIX)) return url
  return `http://localhost:${PRIMARY_PORT}${url.slice(end)}`
}

const decoder = new TextDecoder()

/** A string of bytes, as fetch gives the values of headers, as text. */
function byteStringText(bytes: string): string {
  return decoder.decode(Uint8Array.from(bytes, (character) => character.charCodeAt(0)))
}

/** The code of the system error that caused a failure of fetch, if any. */
function causeCode(error: unknown): unknown {
  const cause: unknown = error instanceof Error ? error.cause : undefined
  return typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
}

/**
 * The failure of curl that a failure of fetch stands for, after
 * `elapsed` milliseconds, as curl reports the errors of its connections.
 */
export function fetchFailure(error: unknown, url: URL, elapsed: number): HttpFailure {
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 42, message: 'Callback aborted' }
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  switch (causeCode(error)) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code: 6, message: `Could not resolve host: ${url.hostname}` }
    case 'ECONNREFUSED':
      return {
        code: 7,
        message: `Failed to connect to ${url.hostname} port ${port} after ${elapsed} ms: Couldn't connect to server`,
      }
    case 'ECONNRESET':
      return { code: 56, message: 'Recv failure: Connection reset by peer' }
    case 'UND_ERR_SOCKET':
      return { code: 52, message: 'Empty reply from server' }
    default: {
      // fetch fails with "fetch failed", and tells why in the cause.
      const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error
      return { code: 56, message: reason instanceof Error ? reason.message : String(reason) }
    }
  }
}

/**
 * An HTTP client that sends requests with fetch, as close to curl as
 * fetch lets it: it guesses http for URLs without a scheme, sends no body
 * with GET or HEAD, which fetch refuses, and gives the names of headers
 * in lower case, as curl does with HTTP/2, with duplicates joined but for
 * Set-Cookie. It verifies the certificates of servers, which FiveM's
 * client does not.
 */
export const fetchHttpClient: HttpClient = async (request) => {
  const text = request.url.includes('://') ? request.url : `http://${request.url}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { code: 3, message: 'URL rejected: Malformed input to a URL function' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { code: 1, message: `Protocol "${url.protocol.slice(0, -1)}" not supported` }
  }
  const method = request.method.toUpperCase()
  const withBody = method !== 'GET' && method !== 'HEAD'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeout)
  const start = Date.now()
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers.map(([name, value]) => [name, value]),
      // fetch takes bodies of their own buffers.
      body: withBody ? request.body.slice() : null,
      redirect: request.followLocation ? 'follow' : 'manual',
      signal: controller.signal,
    })
    clearTimeout(timer)
    const headers: HttpHeader[] = []
    for (const [name, value] of response.headers) headers.push([name, byteStringText(value)])
    return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) }
  } catch (error) {
    return fetchFailure(error, url, Date.now() - start)
  } finally {
    clearTimeout(timer)
  }
}
