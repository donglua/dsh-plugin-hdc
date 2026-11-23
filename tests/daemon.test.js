import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { packRpcMessage, resetDaemonSessions, tryDaemonInput, tryOpenDaemonFrameStream } from '../lib/daemon.js'
import { discoverHdc, forgetHdcCache } from '../lib/hdc.js'
import { latestStreamFrame, trackStreamLatest } from '../lib/frames.js'

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
        } else if (msg.method === 'Captures' && msg.params.api === 'startCaptureScreen') {
          socket.write('{"result":true,"pts":3}\n')
          socket.write(JPEG)
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

    const stream = await tryOpenDaemonFrameStream(fakeHdc, 'FakeSer', {})
    assert.ok(stream !== undefined)
    const it = stream.frames[Symbol.asyncIterator]()
    const frame = await it.next()
    assert.equal(frame.done, false)
    assert.equal(frame.value.mediaType, 'image/jpeg')
    stream.stop()
  } finally {
    resetDaemonSessions()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
