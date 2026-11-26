/**
 * Panel captures: where they land, and how the panel gets them back.
 *
 * Two behaviours are pinned here, both of them regressions that were invisible
 * from the panel side.
 *
 * A capture used to write a JPEG into the Host's working directory every time
 * the 截图 button was pressed, because an unset `downloadDir` fell back to
 * `process.cwd()`. The panel copies to the clipboard, which needs no file, so
 * the bytes are now held in memory and only a configured directory gets one on
 * disk.
 *
 * And an artifact used to be reachable only as a file on disk, so a capture with
 * no file had no way to reach the panel at all. The route serves either shape.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import { chmodSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { clear, recall, remember } from '../lib/artifacts.js'
import { createHandler } from '../lib/routes.js'
import { captureStill } from '../lib/service.js'
import { invalidateTargets } from '../lib/tools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeHdc = path.join(here, 'fake-hdc.sh')
chmodSync(fakeHdc, 0o755)

/** A scratch directory per test, cleaned up afterwards. */
async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-capture-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A response double matching what the route handler touches.
 *
 * `abortOnDisconnect` subscribes to the response, so a plain object with
 * `setHeader`/`end` would fail before the handler ever got to the artifact.
 */
function fakeResponse() {
  const events = new EventEmitter()
  const headers = new Map()
  return {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    body: undefined,
    chunks: [],
    events,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value) },
    getHeader(name) { return headers.get(String(name).toLowerCase()) },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.headersSent = true
      return true
    },
    end(body) {
      if (body !== undefined) this.write(body)
      this.body = body
      this.headersSent = true
      this.writableEnded = true
    },
    writeHead(status) { this.statusCode = status; this.headersSent = true },
    destroy() { this.destroyed = true },
    once(event, listener) { events.once(event, listener); return this },
    off(event, listener) { events.off(event, listener); return this },
    json() { return JSON.parse(String(this.body)) },
  }
}

/** A request double for a bodyless route. */
function fakeRequest(url) {
  const events = new EventEmitter()
  return {
    url,
    method: 'GET',
    events,
    once(event, listener) { events.once(event, listener); return this },
    off(event, listener) { events.off(event, listener); return this },
    resume() {},
  }
}

/** Point the fake client at a fresh scratch directory and forget cached devices. */
function useFakeDevice(t, dir) {
  process.env.DSH_HDC_FAKE_DIR = dir
  process.env.DSH_HDC_FAKE_MODE = 'device'
  invalidateTargets()
  t.after(() => {
    delete process.env.DSH_HDC_FAKE_DIR
    delete process.env.DSH_HDC_FAKE_MODE
    invalidateTargets()
  })
}

test('a capture with no configured directory writes nothing and keeps the bytes', async (t) => {
  const dir = await scratch(t)
  useFakeDevice(t, dir)
  clear()

  // The working directory is where an unset `downloadDir` used to fall back to,
  // so it is also where the litter showed up.
  const before = readdirSync(dir)
  const captured = await captureStill({ hdcPath: fakeHdc }, undefined, new AbortController().signal)

  assert.equal(captured.savedPath, undefined, 'no path is reported when no file was written')
  assert.deepEqual(readdirSync(dir), before, 'the capture directory must not gain a file')
  assert.equal(typeof captured.artifactId, 'string')
  assert.equal(typeof captured.mediaType, 'string')
  assert.match(captured.name, /^hdc-shot-.*\.(?:jpg|png)$/u, 'the caption name is reported even with no file')
  assert.ok(captured.bytes > 0, 'the bytes are still there to copy')

  const entry = recall(captured.artifactId)
  assert.ok(entry !== undefined, 'the capture is reachable by its id')
  assert.equal(entry.path, undefined, 'nothing was written to disk')
  assert.equal(entry.data.byteLength, captured.bytes, 'the artifact holds the captured bytes')
  assert.match(entry.name, /^hdc-shot-.*\.(?:jpg|png)$/u, 'the caption still names the image')
})

test('a configured directory receives the file and reports where', async (t) => {
  const dir = await scratch(t)
  useFakeDevice(t, dir)
  clear()
  const shots = path.join(dir, 'shots')

  const captured = await captureStill({ hdcPath: fakeHdc, downloadDir: shots }, undefined, new AbortController().signal)

  assert.equal(typeof captured.savedPath, 'string')
  assert.equal(path.dirname(captured.savedPath), shots)
  assert.deepEqual(readdirSync(shots), [path.basename(captured.savedPath)], 'the file is written where it was asked for')

  const entry = recall(captured.artifactId)
  assert.equal(entry.path, captured.savedPath, 'the artifact serves the file it wrote')
  assert.equal(entry.data, undefined)
  const written = await readFile(captured.savedPath)
  assert.equal(written.byteLength, captured.bytes)
})

test('the artifact route serves bytes held in memory, not just files', async (t) => {
  clear()
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const id = remember({ data: bytes, mediaType: 'image/png', name: 'hdc-shot.png', kind: 'screenshot' })
  const handler = createHandler({})
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    // `close` waits for keep-alive sockets the fetch left open, so they are
    // given up first: otherwise this test spends the suite's idle timeout here.
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  const { port } = server.address()

  const response = await fetch(`http://127.0.0.1:${port}/hdc/artifact/${encodeURIComponent(id)}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('content-length'), String(bytes.byteLength))
  assert.match(response.headers.get('content-disposition') ?? '', /filename="hdc-shot\.png"/u)
  assert.deepEqual([...Buffer.from(await response.arrayBuffer())], [...bytes], 'the bytes must arrive intact')
})

test('an artifact with neither bytes nor a path is refused at registration', () => {
  assert.throws(() => remember({ mediaType: 'image/png', name: 'x.png', kind: 'screenshot' }), /bytes or a path/u)
})

test('inline captures are evicted oldest-first to stay within the byte budget', async () => {
  // The budget bounds Host memory rather than counting entries: the entry cap
  // alone would let twenty-four large captures sit in memory at once, and the
  // newest capture is the one about to be pasted.
  clear()
  const { MAX_INLINE_BYTES } = await import('../lib/artifacts.js')
  const chunkBytes = 10 * 1024 * 1024
  const chunk = Buffer.alloc(chunkBytes, 7)
  const fits = Math.floor(MAX_INLINE_BYTES / chunkBytes)
  assert.ok(fits >= 2, 'the budget must hold more than one capture to be meaningful')

  const ids = []
  // One more than fits, so the eviction is caused by the budget rather than by
  // the separate entry cap.
  for (let index = 0; index <= fits; index += 1) {
    ids.push(remember({ data: chunk, mediaType: 'image/jpeg', name: `b${index}.jpg`, kind: 'screenshot' }))
  }

  assert.equal(recall(ids[0]), undefined, 'the oldest capture is evicted to stay within the budget')
  for (const id of ids.slice(1)) assert.ok(recall(id) !== undefined, 'every newer capture is still there')
  clear()
})

test('a recording still resolves a directory when none is configured', async (t) => {
  // A video is a file by definition, so this path must keep working with the
  // setting unset — only the still stopped writing one.
  const dir = await scratch(t)
  useFakeDevice(t, dir)
  clear()
  const { record } = await import('../lib/service.js')
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    const recorded = await record({ hdcPath: fakeHdc }, undefined, { seconds: 1 }, new AbortController().signal)
    assert.equal(typeof recorded.savedPath, 'string')
    // macOS reports `/private/var/...` for a path under `/var/...`, so the
    // comparison is on the resolved directories rather than their spelling.
    assert.equal(
      await realpath(path.dirname(recorded.savedPath)),
      await realpath(dir),
      'an unconfigured recording still lands in the working directory',
    )
  } finally {
    process.chdir(cwd)
  }
})

test('a recording reports the media type its file actually has', async (t) => {
  // The panel used to guess `video/mp4` from `kind` and pass that guess to the
  // save dialog. The type belongs to the artifact that was made.
  const dir = await scratch(t)
  useFakeDevice(t, dir)
  clear()
  const { record } = await import('../lib/service.js')
  const recorded = await record({ hdcPath: fakeHdc, downloadDir: path.join(dir, 'rec') }, undefined, { seconds: 1 }, new AbortController().signal)
  assert.equal(recorded.kind, 'video')
  assert.equal(recorded.mediaType, 'video/mp4')
  assert.equal(recall(recorded.artifactId).mediaType, recorded.mediaType, 'the artifact and the report agree')
})

test('a file artifact whose file disappeared is still a 404, not a crash', async (t) => {
  clear()
  const dir = await scratch(t)
  const file = path.join(dir, 'gone.png')
  await writeFile(file, Buffer.from([1, 2, 3]))
  const id = remember({ path: file, mediaType: 'image/png', name: 'gone.png', kind: 'screenshot' })
  await rm(file)
  const handler = createHandler({})
  const res = fakeResponse()
  await handler(fakeRequest(`/hdc/artifact/${id}`), res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error.code, 'HDC_UNKNOWN_ARTIFACT')
})
