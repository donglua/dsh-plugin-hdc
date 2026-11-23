/**
 * Persistent TCP fast path to HarmonyOS `uitest start-daemon singleness`
 * (`@uitest_socket` forwarded via `hdc fport`).
 *
 * When the device has `/data/local/tmp/agent.so` (installed by Hypium /
 * DevEco / xdevice), the `uitest` daemon exposes a JSON-RPC server over
 * `@uitest_socket` that runs taps/swipes in ~100 ms and streams JPEG frames on
 * screen updates without spawning `hdc` or `snapshot_display` per frame.
 *
 * Every entry point here is strictly best-effort: if the device lacks
 * `agent.so`, `fport` fails, or any RPC errors/times out, the device enters a
 * cooldown and callers fall back transparently to the standard `hdc shell`
 * implementation.
 *
 * @module hdc-tools/daemon
 */

import net from 'node:net'
import { runHdc, shell } from './hdc.js'

const RPC_HEAD = Buffer.from('_uitestkit_rpc_message_head_')
const RPC_TAIL = Buffer.from('_uitestkit_rpc_message_tail_')
const HYPIUM_MODULE = 'com.ohos.devicetest.hypiumApiHelper'

/** Cooldown after a device fails daemon probing, so we don't retry every tap. */
const COOLDOWN_MS = 60_000
const RPC_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 2_500

/** Per-serial persistent control session state. */
const sessions = new Map()

/** Exported for tests to reset daemon state. */
export function resetDaemonSessions() {
  for (const session of sessions.values()) {
    session.socket?.destroy()
  }
  sessions.clear()
}

function getSession(serial) {
  let session = sessions.get(serial)
  if (session === undefined) {
    session = {
      serial,
      localPort: undefined,
      socket: undefined,
      driver: undefined,
      connectPromise: undefined,
      cooldownUntil: 0,
      rpcChain: Promise.resolve(),
      nextId: 1,
    }
    sessions.set(serial, session)
  }
  return session
}

/** Frame one RPC request with `_uitestkit_rpc_message_head_` / `_tail_`. */
export function packRpcMessage(id, payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const header = Buffer.alloc(8)
  header.writeUInt32BE(id >>> 0, 0)
  header.writeUInt32BE(payload.byteLength >>> 0, 4)
  return Buffer.concat([RPC_HEAD, header, payload, RPC_TAIL])
}

/** Pick an ephemeral local TCP port on 127.0.0.1. */
function allocateLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('failed to allocate local port'))
      })
    })
  })
}

/** Connect a TCP socket to 127.0.0.1:port with a short timeout. */
function connectTcp(port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const socket = net.connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error('tcp connect timeout'))
    }, CONNECT_TIMEOUT_MS)
    const onAbort = () => {
      cleanup()
      socket.destroy()
      reject(new Error('aborted'))
    }
    const onError = (err) => {
      cleanup()
      socket.destroy()
      reject(err)
    }
    const onConnect = () => {
      cleanup()
      // Disable Nagle so rapid touchMove packets flush immediately without delayed-ACK stalls.
      socket.setNoDelay(true)
      resolve(socket)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.off('error', onError)
      socket.off('connect', onConnect)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('error', onError)
    socket.once('connect', onConnect)
  })
}

/** Send one JSON-RPC request on a dedicated/serialized socket and await JSON line. */
function sendRpcOnSocket(socket, id, body, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('uitest rpc timeout'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('uitest socket closed'))
    }
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const text = buffer.toString('utf8')
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1))
          cleanup()
          resolve(parsed)
        } catch {
          // Wait for remaining bytes if JSON is split across chunks.
        }
      }
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(packRpcMessage(id, body))
  })
}

/** Allocate a fresh local TCP port and forward `@uitest_socket` to it. */
async function createForwardPort(hdcPath, serial, signal) {
  const check = await shell(hdcPath, serial, 'test -s /data/local/tmp/agent.so && echo OK', {
    signal,
    timeoutMs: 2500,
  })
  if (!check.ok || !check.stdout.includes('OK')) return undefined
  const port = await allocateLocalPort()
  const fwd = await runHdc(
    hdcPath,
    serial,
    ['fport', `tcp:${port}`, 'localabstract:uitest_socket'],
    { signal, timeoutMs: 3000 },
  )
  return fwd.ok ? port : undefined
}

/** Connect to `port`, starting `uitest start-daemon singleness` if nothing is listening yet. */
async function connectOrStartDaemon(hdcPath, serial, port, signal) {
  try {
    return await connectTcp(port, signal)
  } catch {
    await shell(
      hdcPath,
      serial,
      'nohup uitest start-daemon singleness >/dev/null 2>&1 </dev/null &',
      { signal, timeoutMs: 3000 },
    )
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        return await connectTcp(port, signal)
      } catch {
        // keep waiting for daemon socket readiness
      }
    }
    return undefined
  }
}

/** Ensure `fport` + `uitest start-daemon singleness` + `Driver#0` are ready. */
async function ensureDaemonPort(hdcPath, serial, signal) {
  if (process.env.DSH_HDC_DISABLE_DAEMON === '1') return undefined
  const session = getSession(serial)
  if (Date.now() < session.cooldownUntil) return undefined

  if (session.localPort !== undefined) {
    // Quick probe: if socket is still alive, return immediately.
    if (session.socket !== undefined && !session.socket.destroyed) return session.localPort
  }

  if (session.connectPromise !== undefined) return session.connectPromise

  session.connectPromise = (async () => {
    try {
      // 1. Reuse an existing fport if present, otherwise verify agent.so and create one.
      const existing = await runHdc(hdcPath, serial, ['fport', 'ls'], { signal, timeoutMs: 2500 })
      let port
      let reused = false
      if (existing.ok) {
        const match = /tcp:(\d+)\s+localabstract:uitest_socket/u.exec(existing.stdout)
        if (match !== null) {
          port = Number(match[1])
          reused = true
        }
      }
      if (port === undefined) {
        port = await createForwardPort(hdcPath, serial, signal)
        if (port === undefined) {
          session.cooldownUntil = Date.now() + COOLDOWN_MS
          return undefined
        }
      }

      // 2. Connect TCP; if a pre-existing fport is stale and refuses even after
      //    starting the daemon, replace it with a fresh forward and connect once more.
      let sock = await connectOrStartDaemon(hdcPath, serial, port, signal)
      if (sock === undefined && reused) {
        await runHdc(hdcPath, serial, ['fport', 'rm', `tcp:${port}`, 'localabstract:uitest_socket'], {
          signal,
          timeoutMs: 2500,
        })
        const freshPort = await createForwardPort(hdcPath, serial, signal)
        if (freshPort !== undefined) {
          port = freshPort
          sock = await connectOrStartDaemon(hdcPath, serial, port, signal)
        }
      }

      if (sock === undefined) {
        session.cooldownUntil = Date.now() + COOLDOWN_MS
        return undefined
      }

      // 3. Create Driver handle on the control socket.
      const id = session.nextId++
      const res = await sendRpcOnSocket(sock, id, {
        module: HYPIUM_MODULE,
        method: 'callHypiumApi',
        params: { api: 'Driver.create', this: null, args: [], message_type: 'hypium' },
        request_id: String(id),
      })
      if (typeof res?.result !== 'string' || !res.result.startsWith('Driver#')) {
        sock.destroy()
        session.cooldownUntil = Date.now() + COOLDOWN_MS
        return undefined
      }

      session.localPort = port
      session.socket = sock
      session.driver = res.result
      sock.once('close', () => {
        if (session.socket === sock) {
          session.socket = undefined
          session.driver = undefined
        }
      })
      sock.once('error', () => {
        sock.destroy()
      })
      return port
    } catch {
      session.cooldownUntil = Date.now() + COOLDOWN_MS
      return undefined
    } finally {
      session.connectPromise = undefined
    }
  })()

  return session.connectPromise
}

/** Run one serialized RPC on the persistent control socket; returns `{ ok, result }` or `undefined`. */
async function callSessionRpc(hdcPath, serial, buildRequest, signal) {
  const port = await ensureDaemonPort(hdcPath, serial, signal)
  if (port === undefined) return undefined
  const session = getSession(serial)

  const task = session.rpcChain.then(async () => {
    if (session.socket === undefined || session.socket.destroyed || session.driver === undefined) {
      const reconnected = await ensureDaemonPort(hdcPath, serial, signal)
      if (reconnected === undefined) return undefined
    }
    const id = session.nextId++
    try {
      const res = await sendRpcOnSocket(session.socket, id, buildRequest(id, session))
      if (res?.exception !== undefined && res.exception !== '' && res.exception !== null) return undefined
      return { ok: true, result: res?.result }
    } catch {
      session.socket?.destroy()
      session.socket = undefined
      session.driver = undefined
      return undefined
    }
  })

  session.rpcChain = task.catch(() => {})
  return task
}

/** Run a serialized Hypium Driver call; returns `{ ok, result }` or `undefined` to fallback. */
function callDriver(hdcPath, serial, api, args, signal) {
  return callSessionRpc(
    hdcPath,
    serial,
    (id, session) => ({
      module: HYPIUM_MODULE,
      method: 'callHypiumApi',
      params: { api, this: session.driver, args, message_type: 'hypium' },
      request_id: String(id),
    }),
    signal,
  )
}

/** Run a serialized low-level Gestures call (`touchDown` / `touchMove` / `touchUp`). */
function callGesture(hdcPath, serial, api, args, signal) {
  return callSessionRpc(
    hdcPath,
    serial,
    (id) => ({
      module: HYPIUM_MODULE,
      method: 'Gestures',
      params: { api, args },
      request_id: String(id),
    }),
    signal,
  )
}

/**
 * Attempt an input action over `@uitest_socket`.
 * Returns `{ command, output }` on success, or `undefined` if unsupported / unavailable
 * (caller should fall back to `hdc shell uitest uiInput`).
 */
export async function tryDaemonInput(hdcPath, serial, args, signal) {
  if (args.action === 'touchDown' || args.action === 'touchMove' || args.action === 'touchUp') {
    const x = Math.trunc(args.x)
    const y = Math.trunc(args.y)
    const outcome = await callGesture(hdcPath, serial, args.action, { x, y }, signal)
    if (outcome === undefined) return undefined
    return { command: `${args.action} ${x} ${y}`, output: undefined }
  }

  let api
  let rpcArgs
  let commandText
  switch (args.action) {
    case 'click':
      api = 'Driver.click'
      rpcArgs = [Math.trunc(args.x), Math.trunc(args.y)]
      commandText = `click ${rpcArgs[0]} ${rpcArgs[1]}`
      break
    case 'doubleClick':
      api = 'Driver.doubleClick'
      rpcArgs = [Math.trunc(args.x), Math.trunc(args.y)]
      commandText = `doubleClick ${rpcArgs[0]} ${rpcArgs[1]}`
      break
    case 'longClick':
      api = 'Driver.longClick'
      rpcArgs = [Math.trunc(args.x), Math.trunc(args.y)]
      commandText = `longClick ${rpcArgs[0]} ${rpcArgs[1]}`
      break
    case 'swipe':
    case 'drag': {
      const x1 = Math.trunc(args.x)
      const y1 = Math.trunc(args.y)
      const x2 = Math.trunc(args.to_x)
      const y2 = Math.trunc(args.to_y)
      const vel = typeof args.velocity === 'number' && Number.isFinite(args.velocity)
        ? Math.min(40_000, Math.max(200, Math.trunc(args.velocity)))
        : 600
      api = args.action === 'drag' ? 'Driver.drag' : 'Driver.swipe'
      rpcArgs = [x1, y1, x2, y2, vel]
      commandText = `${args.action} ${x1} ${y1} ${x2} ${y2} ${vel}`
      break
    }
    case 'key':
      if (args.key === 'Back') {
        api = 'Driver.pressBack'
        rpcArgs = []
        commandText = 'keyEvent Back'
      } else if (args.key === 'Home') {
        api = 'Driver.pressHome'
        rpcArgs = []
        commandText = 'keyEvent Home'
      } else {
        return undefined
      }
      break
    default:
      return undefined
  }

  const outcome = await callDriver(hdcPath, serial, api, rpcArgs, signal)
  if (outcome === undefined) return undefined
  return { command: commandText, output: undefined }
}

/**
 * Open a live JPEG frame stream over a dedicated `@uitest_socket` connection.
 * Returns `undefined` if the daemon is unavailable on this device.
 */
export async function tryOpenDaemonFrameStream(hdcPath, serial, options = {}) {
  const port = await ensureDaemonPort(hdcPath, serial, options.signal)
  if (port === undefined) return undefined

  let socket
  try {
    socket = await connectTcp(port, options.signal)
  } catch {
    return undefined
  }

  const scale = typeof options.width === 'number' && options.width > 0 && options.width < 1000
    ? 0.5
    : 1.0

  // Request screen capture stream; wait for the ack + first JPEG frame within 3s.
  // If no frame arrives, close and return undefined so caller falls back cleanly.
  const id = 1
  const req = packRpcMessage(id, {
    module: HYPIUM_MODULE,
    method: 'Captures',
    params: { api: 'startCaptureScreen', args: { options: { scale } } },
    request_id: String(id),
  })

  let closed = false
  let resolveDone
  const done = new Promise((r) => {
    resolveDone = r
  })

  const queue = []
  let waiter = null
  let buffer = Buffer.alloc(0)
  const SOI = Buffer.from([0xff, 0xd8])
  const EOI = Buffer.from([0xff, 0xd9])

  const pushFrame = (data) => {
    const item = { data, mediaType: 'image/jpeg', at: Date.now() }
    if (waiter !== null) {
      const w = waiter
      waiter = null
      w.resolve({ value: item, done: false })
    } else {
      // Keep bounded backlog in case consumer is momentarily slower.
      if (queue.length >= 4) queue.shift()
      queue.push(item)
    }
  }

  const finish = () => {
    if (closed) return
    closed = true
    if (waiter !== null) {
      const w = waiter
      waiter = null
      w.resolve({ value: undefined, done: true })
    }
    resolveDone()
  }

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    for (;;) {
      const soi = buffer.indexOf(SOI)
      if (soi < 0) {
        // Keep last byte in case 0xFF is at the very end of buffer.
        if (buffer.length > 1) buffer = buffer.subarray(buffer.length - 1)
        break
      }
      if (soi > 0) buffer = buffer.subarray(soi)
      const eoi = buffer.indexOf(EOI, 2)
      if (eoi < 0) break
      const frame = Buffer.from(buffer.subarray(0, eoi + 2))
      buffer = buffer.subarray(eoi + 2)
      pushFrame(frame)
    }
  })
  socket.once('close', finish)
  socket.once('error', () => {
    socket.destroy()
    finish()
  })

  socket.write(req)

  // Wait up to 2.5s for the first frame to verify streaming works on this device.
  const firstFrame = await Promise.race([
    new Promise((resolve) => {
      if (queue.length > 0) resolve(queue.shift())
      else waiter = { resolve: (step) => resolve(step.done ? undefined : step.value) }
    }),
    new Promise((resolve) => setTimeout(() => resolve(undefined), 2500)),
  ])

  if (firstFrame === undefined) {
    socket.destroy()
    finish()
    return undefined
  }

  // Re-insert the verified first frame at the front so the consumer gets it immediately.
  queue.unshift(firstFrame)

  const frames = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiter = { resolve }
          })
        },
      }
    },
  }

  return {
    child: undefined,
    frames,
    done,
    stderr: '',
    get exited() {
      return closed
    },
    stop() {
      if (!closed) {
        try {
          socket.write(packRpcMessage(2, {
            module: HYPIUM_MODULE,
            method: 'Captures',
            params: { api: 'stopCaptureScreen', args: [] },
            request_id: '2',
          }))
        } catch {
          // ignore
        }
        socket.destroy()
        finish()
      }
    },
  }
}
