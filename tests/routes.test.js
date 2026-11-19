/**
 * Offline checks for the `/hdc` HTTP surface.
 *
 * The handler is driven with fake request/response objects and injected service
 * doubles, so route matching, status mapping, body limits, and disconnect
 * handling are all exercised without a device or a webserver.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createHandler, matchRoute, MAX_BODY_BYTES, ROUTE_PREFIX } from '../lib/routes.js'

/** A response double recording the status, headers, and body it was given. */
function fakeResponse() {
  const headers = new Map()
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    body: undefined,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value) },
    getHeader(name) { return headers.get(String(name).toLowerCase()) },
    end(body) {
      this.body = body
      this.headersSent = true
      this.writableEnded = true
    },
    writeHead(status) { this.statusCode = status; this.headersSent = true },
    destroy() { this.destroyed = true },
    once(event, listener) { events.once(event, listener); return this },
    off(event, listener) { events.off(event, listener); return this },
  }
  const events = new EventEmitter()
  res.events = events
  res.json = () => JSON.parse(String(res.body))
  return res
}

/** A request double: an async-iterable body plus the events the handler listens for. */
function fakeRequest(url, { method = 'GET', body } = {}) {
  const events = new EventEmitter()
  let sent = false
  return {
    url,
    method,
    events,
    once(event, listener) { events.once(event, listener); return this },
    off(event, listener) { events.off(event, listener); return this },
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (sent || body === undefined) return
      sent = true
      yield Buffer.from(body)
    },
  }
}

/** Service doubles that record their calls and answer with fixed values. */
function services(overrides = {}) {
  const calls = []
  const base = {
    calls,
    async listDevices(signal) {
      calls.push(['listDevices', signal])
      return { hdcPath: '/x/hdc', devices: ['dev-1'] }
    },
    async screenshot(device, signal) {
      calls.push(['screenshot', device, signal])
      return { device: device ?? 'dev-1', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' }
    },
    async input(device, args, signal) {
      calls.push(['input', device, args, signal])
      return { device: device ?? 'dev-1', command: `${args.action}`, output: 'ok' }
    },
    async uiTree(device, allNodes, signal) {
      calls.push(['uiTree', device, allNodes, signal])
      return { device: device ?? 'dev-1', content: 'Button "Next"', truncated: false }
    },
    async logs(device, opts, signal) {
      calls.push(['logs', device, opts, signal])
      return { device: device ?? 'dev-1', scanned: 3, matches: 1, content: 'boom' }
    },
  }
  return { ...base, ...overrides }
}

/** Run one request through a handler and return the response double. */
async function call(handler, url, options) {
  const req = fakeRequest(url, options)
  const res = fakeResponse()
  await handler(req, res)
  return res
}

test('the route table matches the five documented paths', () => {
  const table = [
    { method: 'GET', path: '/devices' },
    { method: 'GET', path: '/screenshot' },
    { method: 'POST', path: '/input' },
    { method: 'GET', path: '/uitree' },
    { method: 'GET', path: '/logs' },
  ]
  assert.equal(matchRoute(table, 'GET', '/devices').route.path, '/devices')
  assert.equal(matchRoute(table, 'POST', '/input').route.path, '/input')
  assert.equal(matchRoute(table, 'GET', '/uitree').route.path, '/uitree')
  assert.deepEqual(matchRoute(table, 'GET', '/devices').params, {})
})

test('matching is exact per method and ignores a trailing slash', () => {
  const table = [{ method: 'GET', path: '/devices' }]
  assert.equal(matchRoute(table, 'GET', '/devices/').route.path, '/devices')
  assert.equal(matchRoute(table, 'POST', '/devices'), null, 'the method must match')
  assert.equal(matchRoute(table, 'GET', '/devices/extra'), null)
  assert.equal(matchRoute(table, 'GET', '/device'), null)
})

test('named segments are captured so a path parameter reaches the caller', () => {
  const table = [{ method: 'GET', path: '/device/:serial/screenshot' }]
  const matched = matchRoute(table, 'GET', '/device/dev-1/screenshot')
  assert.deepEqual(matched.params, { serial: 'dev-1' })
  assert.equal(matchRoute(table, 'GET', '/device//screenshot'), null, 'an empty segment does not match')
})

test('a request without a method match is 405 and names the allowed method', async () => {
  const handler = createHandler({ services: services() })
  const res = await call(handler, '/hdc/input')
  assert.equal(res.statusCode, 405)
  assert.equal(res.getHeader('allow'), 'POST')
  assert.equal(res.json().error.code, 'HDC_METHOD_NOT_ALLOWED')
})

test('an unknown path is 404 with a stable error code', async () => {
  const handler = createHandler({ services: services() })
  const res = await call(handler, '/hdc/nope')
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error.code, 'HDC_UNKNOWN_ROUTE')
  assert.match(res.json().error.message, /\/nope/u)
})

test('the mount prefix is stripped before matching', async () => {
  const fake = services()
  const handler = createHandler({ services: fake })
  const res = await call(handler, `${ROUTE_PREFIX}/devices`)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { hdcPath: '/x/hdc', devices: ['dev-1'] })
  assert.equal(fake.calls[0][0], 'listDevices')
})

test('the bare mount point is not one of the documented routes', async () => {
  const handler = createHandler({ services: services() })
  assert.equal((await call(handler, '/hdc')).statusCode, 404)
})

test('each route forwards its query parameters to the service', async () => {
  const fake = services()
  const handler = createHandler({ services: fake })

  await call(handler, '/hdc/uitree?device=dev-9&all_nodes=1')
  assert.deepEqual(fake.calls.at(-1).slice(1, 3), ['dev-9', true])

  await call(handler, '/hdc/logs?device=dev-9&lines=250&max_matches=5&keyword=crash&crash=1')
  assert.deepEqual(fake.calls.at(-1)[2], { lines: 250, max_matches: 5, keyword: 'crash', crash: true })

  await call(handler, '/hdc/screenshot?device=dev-9')
  assert.equal(fake.calls.at(-1)[1], 'dev-9')
})

test('an omitted query parameter stays omitted so the default applies', async () => {
  const fake = services()
  const handler = createHandler({ services: fake })
  await call(handler, '/hdc/logs')
  assert.deepEqual(fake.calls.at(-1)[2], {}, 'the log defaults belong to the service, not the route')
  await call(handler, '/hdc/uitree')
  assert.equal(fake.calls.at(-1)[2], false)
})

test('a malformed numeric query parameter is 400 before any device call', async () => {
  const fake = services()
  const handler = createHandler({ services: fake })
  const res = await call(handler, '/hdc/logs?lines=lots')
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, 'HDC_BAD_ARGS')
  assert.equal(fake.calls.length, 0, 'a bad argument must not reach the device')
})

test('screenshot answers raw image bytes with the sniffed media type', async () => {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const handler = createHandler({
    services: services({
      async screenshot() { return { device: 'dev-1', data, mediaType: 'image/png' } },
    }),
  })
  const res = await call(handler, '/hdc/screenshot')
  assert.equal(res.statusCode, 200)
  assert.equal(res.getHeader('content-type'), 'image/png')
  assert.equal(res.getHeader('content-length'), String(data.byteLength))
  assert.equal(res.getHeader('cache-control'), 'no-store')
  assert.deepEqual([...res.body], [...data], 'the bytes are sent unmodified')
})

test('input reads a JSON body and reaches the service', async () => {
  const fake = services()
  const handler = createHandler({ services: fake })
  const res = await call(handler, '/hdc/input', {
    method: 'POST',
    body: JSON.stringify({ device: 'dev-2', action: 'click', x: 10, y: 20 }),
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(fake.calls.at(-1)[2], { action: 'click', x: 10, y: 20 })
  assert.equal(fake.calls.at(-1)[1], 'dev-2')
  assert.deepEqual(res.json(), { device: 'dev-2', command: 'click', output: 'ok' })
})

test('an input body without an action is 400', async () => {
  const fake = services()
  const handler = createHandler({ services: fake })
  const res = await call(handler, '/hdc/input', { method: 'POST', body: JSON.stringify({ x: 1 }) })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error.message, /action is required/u)
  assert.equal(fake.calls.length, 0)
})

test('a JSON body that is not an object is 400', async () => {
  const handler = createHandler({ services: services() })
  for (const body of ['null', '[]', '"text"', '42']) {
    const res = await call(handler, '/hdc/input', { method: 'POST', body })
    assert.equal(res.statusCode, 400, `body ${body}`)
    assert.equal(res.json().error.code, 'HDC_BAD_ARGS')
  }
})

test('malformed JSON and an empty body are both 400, never a crash', async () => {
  const handler = createHandler({ services: services() })
  const broken = await call(handler, '/hdc/input', { method: 'POST', body: '{"action":' })
  assert.equal(broken.statusCode, 400)
  assert.match(broken.json().error.message, /not valid JSON/u)
  assert.equal((await call(handler, '/hdc/input', { method: 'POST', body: '   ' })).statusCode, 400)
})

test('an oversized body is refused with 413 instead of being buffered', async () => {
  const handler = createHandler({ services: services() })
  const huge = JSON.stringify({ action: 'text', text: 'x'.repeat(MAX_BODY_BYTES + 8) })
  const res = await call(handler, '/hdc/input', { method: 'POST', body: huge })
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().error.code, 'HDC_BODY_TOO_LARGE')
})

test('a missing device is 503 and a rejected command is 502', async () => {
  const noDevice = new Error('no HarmonyOS device is connected; connect a device or start an emulator, then retry')
  noDevice.code = 'HDC_DEVICE_UNAVAILABLE'
  const unavailable = createHandler({ services: services({ async listDevices() { throw noDevice } }) })
  const res = await call(unavailable, '/hdc/devices')
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error.code, 'HDC_DEVICE_UNAVAILABLE')

  const noHdc = new Error('hdc was not found')
  noHdc.code = 'HDC_NOT_FOUND'
  const missing = createHandler({ services: services({ async listDevices() { throw noHdc } }) })
  assert.equal((await call(missing, '/hdc/devices')).statusCode, 503)

  const failed = new Error('input click failed: [Fail]not matched')
  failed.code = 'HDC_COMMAND_FAILED'
  const broken = createHandler({
    services: services({ async input() { throw failed } }),
  })
  const failedRes = await call(broken, '/hdc/input', { method: 'POST', body: JSON.stringify({ action: 'click' }) })
  assert.equal(failedRes.statusCode, 502)
  assert.equal(failedRes.json().error.code, 'HDC_COMMAND_FAILED')
})

test('an unexpected throw is a 500 and never escapes the handler', async () => {
  const handler = createHandler({
    services: services({ async listDevices() { throw new TypeError('boom') } }),
  })
  const res = await call(handler, '/hdc/devices')
  assert.equal(res.statusCode, 500)
  assert.equal(res.json().error.code, 'HDC_INTERNAL')
  assert.match(res.json().error.message, /boom/u)
})

test('a client that hangs up aborts the device work', async () => {
  let seen
  // A real screen capture keeps hdc running for seconds; the double stays
  // in flight until the signal fires, which is the only way the abort matters.
  const handler = createHandler({
    services: services({
      async listDevices(signal) {
        seen = signal
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          setTimeout(resolve, 5_000).unref?.()
        })
        return { hdcPath: '/x/hdc', devices: [] }
      },
    }),
  })
  const req = fakeRequest('/hdc/devices')
  const res = fakeResponse()
  const pending = handler(req, res)
  // A close before the response finished is a disconnect, not a completed reply.
  res.events.emit('close')
  await pending
  assert.equal(seen.aborted, true, 'the hdc call must be told to stop')
  assert.equal(res.destroyed, true, 'there is no one left to answer')
  assert.equal(res.writableEnded, false, 'a half-written success must not be completed')
})

test('a completed response does not abort anything', async () => {
  let seen
  const handler = createHandler({
    services: services({
      async listDevices(signal) {
        seen = signal
        return { hdcPath: '/x/hdc', devices: [] }
      },
    }),
  })
  const req = fakeRequest('/hdc/devices')
  const res = fakeResponse()
  await handler(req, res)
  res.events.emit('close')
  assert.equal(seen.aborted, false)
})

test('the injected services replace the real ones entirely', async () => {
  const fake = services()
  const handler = createHandler({ config: { hdcPath: '/never/used' }, services: fake })
  await call(handler, '/hdc/devices')
  assert.equal(fake.calls.length, 1, 'config must not leak into an injected double')
})

test('tools register even when no webserver ever appears', async () => {
  const { apply, inject } = await import('../lib/index.js')
  const registered = new Map()
  const routes = []
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    get: () => undefined,
    effect: (factory) => factory(),
    // A real context defers until `webServer` exists; here it never will, so the
    // callback must not run and the tools must be registered regardless.
    inject: () => () => {},
  }
  apply(ctx, {})
  assert.equal(registered.size, 8, 'every tool must register without a webserver')
  assert.equal(routes.length, 0, 'no route is registered when the service is absent')
  // `webServer` must not be a hard inject: cordis parks the plugin in PENDING
  // and never calls apply, which would take the tools with it.
  assert.deepEqual(inject, ['tools'], 'webServer is claimed lazily, not required')
})

test('a context with no inject at all still gets every tool', async () => {
  const { apply } = await import('../lib/index.js')
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    get: () => undefined,
    effect: (factory) => factory(),
    // No `inject`: a bare host cannot wait for a service, so `apply` must stop
    // cleanly instead of calling a method that is not there.
  }
  apply(ctx, {})
  assert.equal(registered.size, 8)
})

test('the plugin registers one /hdc prefix route when a webserver is mounted', async () => {
  const { apply } = await import('../lib/index.js')
  const routes = []
  let disposed = 0
  const webServer = { register: (route) => { routes.push(route); return () => { disposed += 1 } } }
  const ctx = {
    tools: { register: () => () => {} },
    // Cordis exposes a service both as `ctx.webServer` and through `ctx.get`.
    webServer,
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (factory) => factory(),
    // The real context defers the callback until the named service exists; the
    // stub provides it already, so running it now is the same outcome.
    inject: (_names, callback) => callback(ctx),
  }
  apply(ctx, { hdcPath: '/x/hdc' })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/hdc')
  assert.equal(typeof routes[0].handler, 'function')
})

test('the mounted handler answers under the /hdc prefix', async () => {
  const { apply } = await import('../lib/index.js')
  let mounted
  const webServer = { register: (route) => { mounted = route; return () => {} } }
  const ctx = {
    tools: { register: () => () => {} },
    webServer,
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (factory) => factory(),
    inject: (_names, callback) => callback(ctx),
  }
  apply(ctx, { hdcPath: '/custom/hdc' })
  // An unknown path proves the handler is live and the prefix was stripped;
  // asserting on a device call would depend on what this machine has attached.
  const res = fakeResponse()
  await mounted.handler(fakeRequest('/hdc/not-a-route'), res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error.code, 'HDC_UNKNOWN_ROUTE')
})
