import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hasActiveDaemonSession, packRpcMessage, resetDaemonSessions, tryDaemonInput, tryOpenDaemonFrameStream } from '../lib/daemon.js'
import { discoverHdc, forgetHdcCache } from '../lib/hdc.js'
import { latestStreamFrame, trackStreamLatest } from '../lib/frames.js'
import { input as serviceInput } from '../lib/service.js'
import { invalidateTargets } from '../lib/tools.js'

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj'
  + '/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAx'
  + 'EB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk'
  + 'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2'
  + 't7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQD'
  + 'BAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm'
  + 'Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oA'
  + 'DAMBAAIRAxEAPwD5soooroMD/9k=',
  'base64',
)

test('packRpcMessage wraps payload with head, length header, and tail', () => {
  const buf = packRpcMessage(7, { hello: 'world' })
  assert.equal(buf.subarray(0, 28).toString('utf8'), '_uitestkit_rpc_message_head_')
  assert.equal(buf.readUInt32BE(28), 7)
  const len = buf.readUInt32BE(32)
  assert.equal(buf.subarray(36, 36 + len).toString('utf8'), '{"hello":"world"}')
  assert.equal(buf.subarray(36 + len).toString('utf8'), '_uitestkit_rpc_message_tail_')
})

test('discoverHdc caches the resolved path for default options and forgets on request', async () => {
  forgetHdcCache()
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-cache-'))
  try {
    const fake = path.join(dir, 'hdc')
    await writeFile(fake, '#!/bin/sh\nexit 0\n')
    await chmod(fake, 0o755)
    const first = await discoverHdc(fake)
    const second = await discoverHdc(fake)
    assert.equal(first, fake)
    assert.equal(second, fake)
  } finally {
    forgetHdcCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('trackStreamLatest records full-resolution frames and cleans up on stop', async () => {
  const stream = trackStreamLatest('Dev1', {
    frames: (async function* () {
      yield { data: JPEG, mediaType: 'image/jpeg', at: Date.now() }
      await new Promise((r) => setTimeout(r, 40))
    })(),
    stop() {},
  })
  const it = stream.frames[Symbol.asyncIterator]()
  const first = await it.next()
  assert.equal(first.done, false)
  const cached = latestStreamFrame('Dev1', 1000)
  assert.ok(cached !== undefined)
  assert.equal(cached.mediaType, 'image/jpeg')
  stream.stop()
  assert.equal(latestStreamFrame('Dev1', 1000), undefined)
})

test('tryDaemonInput and tryOpenDaemonFrameStream talk to a forwarded uitest_socket server', async () => {
  resetDaemonSessions()
  const receivedCalls = []
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const head = Buffer.from('_uitestkit_rpc_message_head_')
      const tail = Buffer.from('_uitestkit_rpc_message_tail_')
      for (;;) {
        const hi = buf.indexOf(head)
        if (hi < 0) break
        const ti = buf.indexOf(tail, hi + head.length + 8)
        if (ti < 0) break
        const len = buf.readUInt32BE(hi + head.length + 4)
        const jsonText = buf.subarray(hi + head.length + 8, hi + head.length + 8 + len).toString('utf8')
        buf = buf.subarray(ti + tail.length)
        const msg = JSON.parse(jsonText)
        receivedCalls.push(msg)
        if (msg.method === 'callHypiumApi') {
          if (msg.params.api === 'Driver.create') {
            socket.write('{"result":"Driver#0","pts":1}\n')
          } else {
            socket.write('{"result":null,"pts":2}\n')
          }
        } else if (msg.method === 'Gestures') {
          socket.write('{"result":null,"pts":2}\n')
        } else if (msg.method === 'Captures' && msg.params.api === 'startCaptureScreen') {
          socket.write('{"result":true,"pts":3}\n')
          socket.write(JPEG)
          // Burst two extra frames before the consumer reads the next one; only the latest should survive.
          const newer = Buffer.concat([JPEG.subarray(0, JPEG.length - 2), Buffer.from([0x01, 0x02, 0xff, 0xd9])])
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.write(JPEG)
              socket.write(newer)
            }
          }, 15)
        }
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-daemon-'))
  const fakeHdc = path.join(dir, 'hdc')
  await writeFile(fakeHdc, [
    '#!/bin/sh',
    'shift 2 2>/dev/null || true',
    'if [ "$1" = "fport" ] && [ "$2" = "ls" ]; then',
    `  echo "FakeSer tcp:${port} localabstract:uitest_socket [Forward]"`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
  await chmod(fakeHdc, 0o755)

  try {
    const res = await tryDaemonInput(fakeHdc, 'FakeSer', { action: 'click', x: 100, y: 200 })
    assert.deepEqual(res, { command: 'click 100 200', output: undefined })
    assert.equal(receivedCalls.some((m) => m.params.api === 'Driver.click'), true)

    const down = await tryDaemonInput(fakeHdc, 'FakeSer', { action: 'touchDown', x: 12, y: 34 })
    const move = await tryDaemonInput(fakeHdc, 'FakeSer', { action: 'touchMove', x: 56, y: 78 })
    const up = await tryDaemonInput(fakeHdc, 'FakeSer', { action: 'touchUp', x: 56, y: 78 })
    assert.deepEqual(down, { command: 'touchDown 12 34', output: undefined })
    assert.deepEqual(move, { command: 'touchMove 56 78', output: undefined })
    assert.deepEqual(up, { command: 'touchUp 56 78', output: undefined })

    const batch = await tryDaemonInput(fakeHdc, 'FakeSer', {
      action: 'touchBatch',
      steps: [
        { action: 'touchMove', x: 80, y: 100, delayMs: 0 },
        { action: 'touchUp', x: 80, y: 100, delayMs: 0 },
      ],
    })
    assert.deepEqual(batch, { command: 'touchBatch 2', output: undefined })
    assert.deepEqual(
      receivedCalls.filter((m) => m.method === 'Gestures').map((m) => [m.params.api, m.params.args]),
      [
        ['touchDown', { x: 12, y: 34 }],
        ['touchMove', { x: 56, y: 78 }],
        ['touchUp', { x: 56, y: 78 }],
        ['touchMove', { x: 80, y: 100 }],
        ['touchUp', { x: 80, y: 100 }],
      ],
    )

    const stream = await tryOpenDaemonFrameStream(fakeHdc, 'FakeSer', {})
    assert.ok(stream !== undefined)
    const it = stream.frames[Symbol.asyncIterator]()
    const frame = await it.next()
    assert.equal(frame.done, false)
    assert.equal(frame.value.mediaType, 'image/jpeg')
    await new Promise((r) => setTimeout(r, 40))
    const latest = await it.next()
    assert.equal(latest.done, false)
    assert.equal(latest.value.data.byteLength, JPEG.byteLength + 2, 'stale intermediate frame must be dropped in favor of the latest frame')
    stream.stop()
  } finally {
    resetDaemonSessions()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureDaemonPort replaces a stale fport forward that refuses TCP connections', async () => {
  resetDaemonSessions()
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      socket.write('{"result":"Driver#0","pts":1}\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const livePort = server.address().port

  // Allocate an unused port so connectTcp is guaranteed to receive ECONNREFUSED.
  const deadServer = net.createServer()
  await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve))
  const deadPort = deadServer.address().port
  await new Promise((resolve) => deadServer.close(resolve))

  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-stale-fport-'))
  const logFile = path.join(dir, 'hdc.log')
  const fakeHdc = path.join(dir, 'hdc')
  let activePort = deadPort
  // Fake hdc returns the dead port on first fport ls, records fport rm, and
  // listens/forwards on livePort? Wait: allocateLocalPort picks a random port,
  // so instead we verify fport rm was called for deadPort.
  await writeFile(fakeHdc, [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(logFile)}`,
    'shift 2 2>/dev/null || true',
    'if [ "$1" = "fport" ] && [ "$2" = "ls" ]; then',
    `  echo "FakeSer tcp:${deadPort} localabstract:uitest_socket [Forward]"`,
    '  exit 0',
    'fi',
    'if [ "$1" = "fport" ] && [ "$2" = "rm" ]; then',
    '  exit 0',
    'fi',
    'if [ "$1" = "shell" ]; then',
    '  echo "OK"',
    '  exit 0',
    'fi',
    'if [ "$1" = "fport" ]; then',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
  await chmod(fakeHdc, 0o755)

  try {
    // The fresh port won't have a server listening on it (allocateLocalPort picks
    // an arbitrary ephemeral port), so tryDaemonInput returns undefined, AND the
    // log proves it detected the stale port and called fport rm + re-forwarded.
    await tryDaemonInput(fakeHdc, 'FakeSer', { action: 'touchDown', x: 1, y: 2 })
    const { readFile } = await import('node:fs/promises')
    const log = await readFile(logFile, 'utf8')
    assert.match(log, new RegExp(`fport rm tcp:${deadPort} localabstract:uitest_socket`))
    assert.match(log, /fport tcp:\d+ localabstract:uitest_socket/)
    assert.ok(activePort > 0 && livePort > 0)
  } finally {
    resetDaemonSessions()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('live touch skips hdc list targets once an active daemon session exists', async () => {
  resetDaemonSessions()
  invalidateTargets()
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const head = Buffer.from('_uitestkit_rpc_message_head_')
      const tail = Buffer.from('_uitestkit_rpc_message_tail_')
      for (;;) {
        const hi = buf.indexOf(head)
        if (hi < 0) break
        const ti = buf.indexOf(tail, hi + head.length + 8)
        if (ti < 0) break
        const len = buf.readUInt32BE(hi + head.length + 4)
        const msg = JSON.parse(buf.subarray(hi + head.length + 8, hi + head.length + 8 + len).toString('utf8'))
        buf = buf.subarray(ti + tail.length)
        if (msg.method === 'callHypiumApi' && msg.params.api === 'Driver.create') {
          socket.write('{"result":"Driver#0","pts":1}\n')
        } else {
          socket.write('{"result":null,"pts":2}\n')
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-fast-touch-'))
  const logFile = path.join(dir, 'hdc.log')
  const fakeHdc = path.join(dir, 'hdc')
  await writeFile(fakeHdc, [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(logFile)}`,
    'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
    '  echo "FakeSer"',
    '  exit 0',
    'fi',
    'shift 2 2>/dev/null || true',
    'if [ "$1" = "fport" ] && [ "$2" = "ls" ]; then',
    `  echo "FakeSer tcp:${port} localabstract:uitest_socket [Forward]"`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
  await chmod(fakeHdc, 0o755)

  try {
    assert.equal(hasActiveDaemonSession('FakeSer'), false)
    await serviceInput({ hdcPath: fakeHdc }, 'FakeSer', { action: 'touchDown', x: 10, y: 20 })
    assert.equal(hasActiveDaemonSession('FakeSer'), true)

    // Even when the targets cache is cleared, touchMove/touchUp use the open session directly.
    invalidateTargets()
    await serviceInput({ hdcPath: fakeHdc }, 'FakeSer', { action: 'touchMove', x: 30, y: 80 })
    await serviceInput({ hdcPath: fakeHdc }, 'FakeSer', { action: 'touchUp', x: 30, y: 80 })

    const { readFile } = await import('node:fs/promises')
    const lines = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean)
    const listings = lines.filter((line) => line === 'list targets')
    assert.equal(listings.length, 1, `expected 1 list targets call, got ${listings.length}: ${lines.join('; ')}`)

    await assert.rejects(
      () => serviceInput({ hdcPath: fakeHdc }, 'FakeSer', { action: 'touchBatch', steps: [] }),
      (error) => error?.code === 'HDC_BAD_ARGS',
    )
    await assert.rejects(
      () => serviceInput({ hdcPath: fakeHdc }, 'FakeSer', {
        action: 'touchBatch',
        steps: [{ action: 'click', x: 1, y: 2 }],
      }),
      (error) => error?.code === 'HDC_BAD_ARGS',
    )
  } finally {
    resetDaemonSessions()
    invalidateTargets()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('tryOpenDaemonFrameStream recovers from stale copyScreen and flushes stopCaptureScreen', async () => {
  resetDaemonSessions()
  const receivedApis = []
  let activeCapture = true
  let streamSocket
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const head = Buffer.from('_uitestkit_rpc_message_head_')
      const tail = Buffer.from('_uitestkit_rpc_message_tail_')
      for (;;) {
        const hi = buf.indexOf(head)
        if (hi < 0) break
        const ti = buf.indexOf(tail, hi + head.length + 8)
        if (ti < 0) break
        const len = buf.readUInt32BE(hi + head.length + 4)
        const msg = JSON.parse(buf.subarray(hi + head.length + 8, hi + head.length + 8 + len).toString('utf8'))
        buf = buf.subarray(ti + tail.length)
        if (msg.method === 'callHypiumApi' && msg.params.api === 'Driver.create') {
          socket.write('{"result":"Driver#0","pts":1}\n')
        } else if (msg.method === 'Captures') {
          receivedApis.push(msg.params.api)
          if (msg.params.api === 'startCaptureScreen') {
            if (activeCapture) {
              socket.write('{"result":null,"exception":"Capture already running: copyScreen"}\n')
            } else {
              activeCapture = true
              streamSocket = socket
              socket.write('{"result":null,"exception":""}\n')
              socket.write('{"result":true,"pts":10}\n')
              socket.write(JPEG)
            }
          } else if (msg.params.api === 'stopCaptureScreen') {
            activeCapture = false
            socket.write('{"result":true,"pts":11}\n')
          }
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-daemon-recover-'))
  const fakeHdc = path.join(dir, 'hdc')
  await writeFile(fakeHdc, [
    '#!/bin/sh',
    'shift 2 2>/dev/null || true',
    'if [ "$1" = "fport" ] && [ "$2" = "ls" ]; then',
    `  echo "FakeSer tcp:${port} localabstract:uitest_socket [Forward]"`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
  await chmod(fakeHdc, 0o755)

  try {
    const stream = await tryOpenDaemonFrameStream(fakeHdc, 'FakeSer', {})
    assert.ok(stream !== undefined, 'stream must open after recovering stale copyScreen')
    const it = stream.frames[Symbol.asyncIterator]()
    const initial = await it.next()
    assert.equal(initial.done, false)
    assert.deepEqual([...initial.value.data], [...JPEG])

    // Subsequent live update from daemon arrives over the same open stream.
    const updated = Buffer.concat([JPEG.subarray(0, JPEG.length - 2), Buffer.from([0x05, 0x06, 0xff, 0xd9])])
    streamSocket.write(updated)
    const next = await it.next()
    assert.equal(next.done, false)
    assert.deepEqual([...next.value.data], [...updated])

    stream.stop()
    await new Promise((r) => setTimeout(r, 40))
    assert.deepEqual(
      receivedApis,
      ['startCaptureScreen', 'stopCaptureScreen', 'startCaptureScreen', 'stopCaptureScreen'],
      'stop() must flush stopCaptureScreen before destroying the socket',
    )
    assert.equal(activeCapture, false)
  } finally {
    resetDaemonSessions()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('tryOpenDaemonFrameStream falls back and enters capture cooldown when daemon acks without emitting JPEGs', async () => {
  resetDaemonSessions()
  let captureAttempts = 0
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const head = Buffer.from('_uitestkit_rpc_message_head_')
      const tail = Buffer.from('_uitestkit_rpc_message_tail_')
      for (;;) {
        const hi = buf.indexOf(head)
        if (hi < 0) break
        const ti = buf.indexOf(tail, hi + head.length + 8)
        if (ti < 0) break
        const len = buf.readUInt32BE(hi + head.length + 4)
        const msg = JSON.parse(buf.subarray(hi + head.length + 8, hi + head.length + 8 + len).toString('utf8'))
        buf = buf.subarray(ti + tail.length)
        if (msg.method === 'callHypiumApi') {
          socket.write('{"result":"Driver#0","pts":1}\n')
        } else if (msg.method === 'Captures' && msg.params.api === 'startCaptureScreen') {
          captureAttempts += 1
          socket.write('{"result":null,"exception":""}\n')
          socket.write('{"result":true,"pts":3}\n')
          // Emit no JPEG frames (HarmonyOS 7.0 behavior where copyScreen produces no output).
        } else if (msg.method === 'Captures' && msg.params.api === 'stopCaptureScreen') {
          socket.write('{"result":true,"pts":4}\n')
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-daemon-silent-'))
  const fakeHdc = path.join(dir, 'hdc')
  await writeFile(fakeHdc, [
    '#!/bin/sh',
    'shift 2 2>/dev/null || true',
    'if [ "$1" = "fport" ] && [ "$2" = "ls" ]; then',
    `  echo "FakeSer tcp:${port} localabstract:uitest_socket [Forward]"`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
  await chmod(fakeHdc, 0o755)

  try {
    const first = await tryOpenDaemonFrameStream(fakeHdc, 'FakeSer', { firstFrameTimeoutMs: 40 })
    assert.equal(first, undefined, 'must return undefined so caller falls back to openFrameStream')
    assert.equal(captureAttempts, 1)

    // Subsequent openStream skips daemon capture immediately during cooldown while input still works.
    const t0 = Date.now()
    const second = await tryOpenDaemonFrameStream(fakeHdc, 'FakeSer', { firstFrameTimeoutMs: 500 })
    assert.equal(second, undefined)
    assert.ok(Date.now() - t0 < 50, 'cooldown must skip retrying silent daemon capture')
    assert.equal(captureAttempts, 1)
  } finally {
    resetDaemonSessions()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('tryOpenDaemonFrameStream fails fast when daemon returns a non-recoverable error', async () => {
  resetDaemonSessions()
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const head = Buffer.from('_uitestkit_rpc_message_head_')
      const tail = Buffer.from('_uitestkit_rpc_message_tail_')
      for (;;) {
        const hi = buf.indexOf(head)
        if (hi < 0) break
        const ti = buf.indexOf(tail, hi + head.length + 8)
        if (ti < 0) break
        const len = buf.readUInt32BE(hi + head.length + 4)
        const msg = JSON.parse(buf.subarray(hi + head.length + 8, hi + head.length + 8 + len).toString('utf8'))
        buf = buf.subarray(ti + tail.length)
        if (msg.method === 'callHypiumApi') {
          socket.write('{"result":"Driver#0","pts":1}\n')
        } else if (msg.method === 'Captures') {
          socket.write('{"result":null,"exception":"unsupported Captures method"}\n')
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-daemon-err-'))
  const fakeHdc = path.join(dir, 'hdc')
  await writeFile(fakeHdc, [
    '#!/bin/sh',
    'shift 2 2>/dev/null || true',
    'if [ "$1" = "fport" ] && [ "$2" = "ls" ]; then',
    `  echo "FakeSer tcp:${port} localabstract:uitest_socket [Forward]"`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
  await chmod(fakeHdc, 0o755)

  try {
    const t0 = Date.now()
    const stream = await tryOpenDaemonFrameStream(fakeHdc, 'FakeSer', { startupTimeoutMs: 2500 })
    assert.equal(stream, undefined)
    assert.ok(Date.now() - t0 < 1000, 'must fail fast without waiting for startupTimeoutMs')
  } finally {
    resetDaemonSessions()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('tryOpenDaemonFrameStream defaults to scale 0.5, reads Driver.getDisplaySize, and handles JSON without newline', async () => {
  resetDaemonSessions()
  let seenScale
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const head = Buffer.from('_uitestkit_rpc_message_head_')
      const tail = Buffer.from('_uitestkit_rpc_message_tail_')
      for (;;) {
        const hi = buf.indexOf(head)
        if (hi < 0) break
        const ti = buf.indexOf(tail, hi + head.length + 8)
        if (ti < 0) break
        const len = buf.readUInt32BE(hi + head.length + 4)
        const msg = JSON.parse(buf.subarray(hi + head.length + 8, hi + head.length + 8 + len).toString('utf8'))
        buf = buf.subarray(ti + tail.length)
        if (msg.method === 'callHypiumApi' && msg.params.api === 'Driver.create') {
          socket.write('{"result":"Driver#0","pts":1}\n')
        } else if (msg.method === 'callHypiumApi' && msg.params.api === 'Driver.getDisplaySize') {
          socket.write('{"result":{"displayId":0,"x":1216,"y":2688},"pts":2}\n')
        } else if (msg.method === 'Captures' && msg.params.api === 'startCaptureScreen') {
          seenScale = msg.params.args?.options?.scale
          // Emit JSON without trailing newline before JPEG arrives.
          socket.write('{"result":true,"pts":3}')
          setTimeout(() => {
            if (!socket.destroyed) socket.write(JPEG)
          }, 10)
        } else if (msg.method === 'Captures' && msg.params.api === 'stopCaptureScreen') {
          socket.write('{"result":true,"pts":4}\n')
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-daemon-scale-'))
  const fakeHdc = path.join(dir, 'hdc')
  await writeFile(fakeHdc, [
    '#!/bin/sh',
    'shift 2 2>/dev/null || true',
    'if [ "$1" = "fport" ] && [ "$2" = "ls" ]; then',
    `  echo "FakeSer tcp:${port} localabstract:uitest_socket [Forward]"`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'))
  await chmod(fakeHdc, 0o755)

  try {
    const stream = await tryOpenDaemonFrameStream(fakeHdc, 'FakeSer', {})
    assert.ok(stream !== undefined)
    assert.equal(seenScale, 0.5)
    assert.equal(stream.mode, 'daemon')
    assert.equal(stream.scale, 0.5)
    assert.deepEqual(stream.displaySize, { width: 1216, height: 2688 })
    const it = stream.frames[Symbol.asyncIterator]()
    const first = await it.next()
    assert.equal(first.done, false)
    stream.stop()
  } finally {
    resetDaemonSessions()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
