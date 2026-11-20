/**
 * The `/hdc` HTTP surface.
 *
 * A browser UI needs the same device operations the model gets as tools, and it
 * reaches them over the composition's webserver. The table below is deliberately
 * a plain array with a hand-written matcher instead of a framework: this bundle
 * installs from a plain directory with no build step and no dependency, and five
 * fixed routes do not justify one.
 *
 * Two rules shape every handler here. Nothing may escape into the webserver — a
 * throw there is a connection-level failure the browser cannot read — so every
 * request is answered through `sendError`. And a device call can be slow, so the
 * client hanging up aborts the `hdc` process instead of leaving it running for a
 * result nobody will read.
 *
 * @module hdc-tools/routes
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { recall } from './artifacts.js'
import * as defaultServices from './service.js'

/** Route mount point; the webserver delivers the prefix, we strip it. */
export const ROUTE_PREFIX = '/hdc'

/** A request body larger than this is refused instead of buffered. */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * Match one request against the table.
 *
 * Matching is exact on the normalized path with `:name` segments captured into
 * `params`. A path that exists under another method still counts as found by
 * `createHandler` — that is the difference between a 404 and a 405, and telling
 * a caller "no such route" when it only used the wrong verb sends them looking
 * for the wrong problem.
 *
 * @param table - route definitions carrying `method` and `path`.
 * @param method - the request's HTTP method.
 * @param path - pathname with the mount prefix already removed.
 * @returns the matched route with its params, or `null`.
 */
export function matchRoute(table, method, path) {
  const wanted = normalizePath(path)
  const wantedMethod = String(method).toUpperCase()
  for (const route of table) {
    if (route.method !== wantedMethod) continue
    const params = matchPath(route.path, wanted)
    if (params !== null) return { route, params }
  }
  return null
}

/** Whether any route accepts this path under a different method. */
function wildcardMatch(table, path) {
  const wanted = normalizePath(path)
  for (const route of table) {
    if (matchPath(route.path, wanted) !== null) return route
  }
  return undefined
}

/** Collapse the empty path, duplicate slashes, and a trailing slash. */
function normalizePath(path) {
  const text = typeof path === 'string' && path !== '' ? path : '/'
  const leading = text.startsWith('/') ? text : `/${text}`
  const squeezed = leading.replace(/\/{2,}/gu, '/')
  return squeezed.length > 1 && squeezed.endsWith('/') ? squeezed.slice(0, -1) : squeezed
}

/**
 * Match one path template against a pathname.
 * @returns the captured params, or `null` when the template does not apply.
 */
function matchPath(template, path) {
  const expected = template.split('/')
  const actual = path.split('/')
  if (expected.length !== actual.length) return null
  const params = {}
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index]
    if (part.startsWith(':')) {
      if (actual[index] === '') return null
      params[part.slice(1)] = decodeURIComponent(actual[index])
    } else if (part !== actual[index]) {
      return null
    }
  }
  return params
}

/** One stable error shape so the browser can branch on `code`. */
function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { error: { code, message } }, headers)
}

/** Respond with JSON, never cached: every call is a live device fact. */
function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.byteLength))
  res.setHeader('cache-control', 'no-store')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(body)
}

/**
 * Map one failure onto a status the browser can act on.
 *
 * The split is by who can fix it: a bad argument is the caller's (400), a
 * missing client or device is the environment's and is usually transient (503),
 * and a command the device rejected is a gateway failure (502). Anything else is
 * a bug here and stays a 500 rather than being disguised as a device problem.
 */
function errorResponse(error) {
  const code = typeof error?.code === 'string' ? error.code : 'HDC_INTERNAL'
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'HDC_BAD_ARGS':
      return { status: 400, code, message }
    case 'HDC_UNKNOWN_ARTIFACT':
      return { status: 404, code, message }
    case 'HDC_NOT_FOUND':
    case 'HDC_DEVICE_UNAVAILABLE':
      return { status: 503, code, message }
    case 'HDC_COMMAND_FAILED':
    case 'HDC_SCREENSHOT_FAILED':
    case 'HDC_CAPTURE_FAILED':
    case 'HDC_RECORD_FAILED':
    case 'HDC_RECORD_TIMEOUT':
      return { status: 502, code, message }
    default:
      return { status: 500, code, message }
  }
}

/** Read one query parameter as a string, treating blank as absent. */
function queryString(url, name) {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read one query parameter as a flag; `1`, `true`, `yes`, and `on` are true. */
function queryFlag(url, name) {
  const value = queryString(url, name)
  if (value === undefined) return false
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  throw badRequest(`${name} must be 1 or 0`)
}

/** Read one query parameter as a non-negative integer, or leave it to the default. */
function queryInteger(url, name) {
  const value = queryString(url, name)
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value)) throw badRequest(`${name} must be a non-negative integer`)
  return Number(value)
}

/** A 400-shaped failure carrying the code the mapper expects. */
function badRequest(message) {
  const error = new Error(message)
  error.code = 'HDC_BAD_ARGS'
  return error
}

/**
 * Collect a bounded JSON request body.
 *
 * The ceiling is enforced while reading rather than after: a body already over
 * the limit is never buffered, and the stream is drained so the socket can still
 * deliver the error response.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`the request body must not exceed ${MAX_BODY_BYTES} bytes`)
      error.code = 'HDC_BODY_TOO_LARGE'
      req.resume()
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (text.trim() === '') throw badRequest('a JSON body is required')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw badRequest('the request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('the request body must be a JSON object')
  }
  return parsed
}

/**
 * Abort the device work when the client goes away.
 *
 * A screenshot or a log read can hold an `hdc` process for tens of seconds; a
 * browser tab that closes must not leave it running, so the abort fires on the
 * response's `close` until the response has actually been written.
 */
function abortOnDisconnect(req, res) {
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  // `res.close` covers both a completed response and a dropped socket; the
  // `writableEnded` check above keeps a normal finish from aborting anything.
  res.once('close', onClose)
  req.once('error', onClose)
  return { signal: controller.signal, dispose: () => res.off('close', onClose) }
}

/**
 * Only the parameters the client actually sent are parsed, so an absent
 * `lines` keeps the log reader's own default instead of being reset here.
 */
function logOptions(url) {
  const opts = {}
  const lines = queryInteger(url, 'lines')
  if (lines !== undefined) opts.lines = lines
  const maxMatches = queryInteger(url, 'max_matches')
  if (maxMatches !== undefined) opts.max_matches = maxMatches
  const keyword = queryString(url, 'keyword')
  if (keyword !== undefined) opts.keyword = keyword
  if (queryFlag(url, 'crash')) opts.crash = true
  return opts
}

/** Turn an `input` body into the argument object the command builder reads. */
function inputArgs(body) {
  if (typeof body.action !== 'string' || body.action.trim() === '') {
    throw badRequest('action is required')
  }
  // Copy only known fields: the builder validates each one, and passing the
  // whole body through would let an unexpected key reach the command line.
  const args = { action: body.action }
  for (const key of ['x', 'y', 'to_x', 'to_y', 'duration_ms']) {
    if (body[key] !== undefined) args[key] = body[key]
  }
  for (const key of ['text', 'key']) {
    if (body[key] !== undefined) args[key] = body[key]
  }
  return args
}

/**
 * Send image bytes with the sniffed media type.
 *
 * `no-store` matches the JSON responses: the next call captures a new frame, so
 * a cached screenshot would show a stale screen as if it were current.
 */
function sendImage(res, data, mediaType, device) {
  res.statusCode = 200
  res.setHeader('content-type', mediaType)
  res.setHeader('content-length', String(data.byteLength))
  res.setHeader('cache-control', 'no-store')
  if (device !== undefined) res.setHeader('x-hdc-device', device)
  res.end(data)
}

/**
 * Stream frames to the page as MJPEG.
 *
 * `multipart/x-mixed-replace` with `image/jpeg` parts is the one live picture
 * format a plain `<img src>` renders without JavaScript: the browser replaces
 * the picture each time a part arrives, so the panel needs no canvas, no
 * decoder, and no polling loop. The cost is that the response never ends, which
 * is why this route owns its own headers and its own cleanup rather than
 * returning a value the caller would then try to serialize as JSON.
 *
 * The first frame is awaited before the headers are written. Once a 200 with a
 * streaming content type has gone out there is no way to report a failure, so a
 * device that cannot capture must be refused with a real status first.
 */
async function sendStream(services, url, res, signal) {
  const opened = await services.openStream({
    device: queryString(url, 'device'),
    width: queryInteger(url, 'width'),
    height: queryInteger(url, 'height'),
    intervalMs: queryInteger(url, 'interval_ms'),
  }, signal)
  // The service hands back its own frame stream; the route only reads frames,
  // stderr, and stop() from it, so both the real service and a test double that
  // returns the same shape are accepted without a wrapper to drift out of step.
  const stream = opened.stream ?? opened
  const iterator = stream.frames[Symbol.asyncIterator]()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    stream.stop()
  }
  // The page navigated away, or the panel switched device: the capture loop has
  // no reader, so it must stop now instead of running until its frame ceiling.
  res.once('close', close)
  if (signal.aborted) close()

  try {
    const first = await iterator.next()
    if (first.done === true) {
      const detail = stream.stderr.trim() === '' ? '' : `: ${stream.stderr.trim().split('\n')[0]}`
      throw toolFailure(`the device produced no frame${detail}`, 'HDC_CAPTURE_FAILED')
    }
    const boundary = 'dsh-hdc-frame'
    res.statusCode = 200
    res.setHeader('content-type', `multipart/x-mixed-replace; boundary=${boundary}`)
    res.setHeader('cache-control', 'no-store')
    // A buffering proxy would hold frames until the stream ended, which it never
    // does; this asks for no buffering where the header is honoured.
    res.setHeader('x-accel-buffering', 'no')
    writePart(res, boundary, first.value)
    for (;;) {
      if (closed || res.writableEnded) break
      const step = await iterator.next()
      if (step.done === true) break
      writePart(res, boundary, step.value)
    }
  } finally {
    res.off('close', close)
    close()
    // Only a response that already started streaming is ended here. A failure
    // before the first frame must reach the caller's error mapping, and ending
    // the response would mark the headers sent and turn that into a dropped
    // connection instead of a status the browser can read.
    if (res.headersSent && !res.writableEnded) res.end()
  }
}

/** Write one MJPEG part: the declared length, then the bytes. */
function writePart(res, boundary, frame) {
  res.write(Buffer.from(
    `--${boundary}\r\ncontent-type: ${frame.mediaType}\r\ncontent-length: ${frame.data.byteLength}\r\n\r\n`,
    'utf8',
  ))
  res.write(frame.data)
  res.write('\r\n')
}

/** A failure carrying the code `errorResponse` maps, for a route-internal throw. */
function toolFailure(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Send a file the panel produced, by the id that produced it.
 *
 * The id is looked up in the Host's own artifact registry, so a request can only
 * reach a path this plugin wrote. A directory — the frame-sequence fallback when
 * ffmpeg was unavailable — is answered as a JSON listing instead of bytes: the
 * browser cannot usefully download one, and the panel shows the path instead.
 */
async function sendArtifact(res, id) {
  const entry = recall(id)
  if (entry === undefined) throw toolFailure('that artifact is no longer available', 'HDC_UNKNOWN_ARTIFACT')
  let info
  try {
    info = await stat(entry.path)
  } catch {
    throw toolFailure('the file for that artifact is gone', 'HDC_UNKNOWN_ARTIFACT')
  }
  if (info.isDirectory()) {
    return { kind: 'frames', savedPath: entry.path, files: (await readdir(entry.path)).length }
  }
  res.statusCode = 200
  res.setHeader('content-type', entry.mediaType)
  res.setHeader('content-length', String(info.size))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-disposition', `attachment; filename="${entry.name.replace(/["\\]/gu, '_')}"`)
  await pipeline(createReadStream(entry.path), res)
  return undefined
}

/**
 * The device operations, as routes.
 *
 * Every handler returns the service result as JSON unless it sends bytes
 * itself; failures propagate to the caller's `catch` so one mapping covers all.
 */
function routeTable(services) {
  return [
    {
      method: 'GET',
      path: '/devices',
      handle: (_url, _req, _res, signal) => services.listDevices(signal),
    },
    {
      method: 'GET',
      path: '/screenshot',
      async handle(url, _req, res, signal) {
        const shot = await services.screenshot(queryString(url, 'device'), signal)
        sendImage(res, shot.data, shot.mediaType, shot.device)
        return undefined
      },
    },
    {
      method: 'GET',
      path: '/stream',
      async handle(url, _req, res, signal) {
        await sendStream(services, url, res, signal)
        return undefined
      },
    },
    {
      method: 'POST',
      path: '/capture',
      async handle(_url, req, _res, signal) {
        const body = await readJsonBody(req)
        const device = typeof body.device === 'string' ? body.device : undefined
        return services.capture(device, signal)
      },
    },
    {
      method: 'POST',
      path: '/record',
      async handle(_url, req, _res, signal) {
        const body = await readJsonBody(req)
        const device = typeof body.device === 'string' ? body.device : undefined
        return services.record(device, {
          seconds: body.seconds,
          width: body.width,
          height: body.height,
        }, signal)
      },
    },
    {
      method: 'GET',
      path: '/artifact/:id',
      handle: (_url, req, res) => sendArtifact(res, String(req.url ?? '').split('?')[0].split('/').pop()),
    },
    {
      method: 'POST',
      path: '/input',
      async handle(_url, req, _res, signal) {
        const body = await readJsonBody(req)
        const device = typeof body.device === 'string' ? body.device : undefined
        return services.input(device, inputArgs(body), signal)
      },
    },
    {
      method: 'GET',
      path: '/uitree',
      handle: (url, _req, _res, signal) => services.uiTree(
        queryString(url, 'device'),
        queryFlag(url, 'all_nodes'),
        signal,
      ),
    },
    {
      method: 'GET',
      path: '/logs',
      handle: (url, _req, _res, signal) => services.logs(queryString(url, 'device'), logOptions(url), signal),
    },
  ]
}

/**
 * Bind the plugin config to the real operations.
 *
 * The route table calls a device operation without a config, so the same table
 * works against an injected test double; this is the one place that knows the
 * config exists.
 */
function bindConfig(config) {
  return {
    listDevices: (signal) => defaultServices.listDevices(config, signal),
    screenshot: (device, signal) => defaultServices.screenshot(config, device, signal),
    input: (device, args, signal) => defaultServices.input(config, device, args, signal),
    uiTree: (device, allNodes, signal) => defaultServices.uiTree(config, device, allNodes, signal),
    logs: (device, opts, signal) => defaultServices.logs(config, device, opts, signal),
    capture: (device, signal) => defaultServices.captureStill(config, device, signal),
    record: (device, opts, signal) => defaultServices.record(config, device, opts, signal),
    openStream: (options, signal) => defaultServices.openStream(config, options, signal),
  }
}

/**
 * Build the request handler registered on the webserver's `/hdc` prefix.
 *
 * @param options.config - resolved plugin config (`hdcPath`, `downloadDir`).
 * @param options.services - device operations; defaults to `lib/service.js` bound
 *   to `config`, and exists so the routes can be tested without a device.
 * @param options.prefix - mount point stripped before matching.
 * @returns a handler that answers every request and never throws.
 */
export function createHandler({ config = {}, services, prefix = ROUTE_PREFIX } = {}) {
  const table = routeTable(services ?? bindConfig(config))

  return async function handleRequest(req, res) {
    const { signal, dispose } = abortOnDisconnect(req, res)
    try {
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const path = stripPrefix(url.pathname, prefix)
      const matched = matchRoute(table, req.method, path)
      if (matched === null) {
        const other = wildcardMatch(table, path)
        if (other === undefined) {
          sendError(res, 404, 'HDC_UNKNOWN_ROUTE', `no route for ${String(req.method)} ${path}`)
        } else {
          sendError(res, 405, 'HDC_METHOD_NOT_ALLOWED', `${path} accepts ${other.method}, not ${String(req.method)}`, {
            allow: other.method,
          })
        }
        return
      }
      const value = await matched.route.handle(url, req, res, signal)
      // A handler that wrote bytes owns the response; only JSON goes through here.
      if (value !== undefined) sendJson(res, 200, value)
    } catch (error) {
      // The client hung up: there is no one left to answer, and writing to the
      // dead socket would only raise again.
      if (signal.aborted) {
        if (!res.writableEnded) res.destroy()
        return
      }
      const mapped = error?.code === 'HDC_BODY_TOO_LARGE'
        ? { status: 413, code: 'HDC_BODY_TOO_LARGE', message: error.message }
        : errorResponse(error)
      // A response already in flight cannot be given a status; destroy it so the
      // browser sees a failed request instead of a truncated success.
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendError(res, mapped.status, mapped.code, mapped.message)
    } finally {
      dispose()
    }
  }
}

/** Remove the mount prefix, leaving `/` for the bare mount point. */
function stripPrefix(pathname, prefix) {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (base === '' || base === '/') return pathname
  if (pathname === base) return '/'
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length)
  // Registered as a prefix, so this cannot normally happen; matching the whole
  // path anyway keeps a direct caller (a test, another mount) working.
  return pathname
}
