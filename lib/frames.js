/**
 * Frame capture: the live picture and the recording, from one device loop.
 *
 * This device build no longer ships `screenrecord`, and `uitest` has no
 * recording subcommand either (checked on a HarmonyOS 7.0.0 phone: the binary
 * is absent from `/system/bin`, and `snapshot_display` is the only command that
 * captures a frame). The only way to get motion off such a device is to grab
 * stills in sequence and join them on the Host, so the panel's live picture and
 * the `hdc_record` tool are the same thing at two cadences:
 *
 *   1. one `hdc shell` connection runs a loop that captures a frame, prints
 *      `FRAME <bytes>`, then writes the raw bytes;
 *   2. the Host reads that stream, so a frame costs neither a new process spawn
 *      nor a second file-transfer round trip;
 *   3. the frames become an MJPEG response (live picture) or an mp4 (recording).
 *
 * The length prefix is what makes the stream usable. `hdc shell` adds no framing
 * of its own and a JPEG contains `0x0a` bytes, so no delimiter can end a frame —
 * only a declared length can.
 *
 * Measured on that phone, one frame takes 0.4–0.7 s at any resolution from
 * 480 px wide to full screen: the capture itself dominates, not the pixels. The
 * live picture therefore runs at roughly 2 frames per second. That is the
 * device's ceiling, not a setting.
 *
 * @module hdc-tools/frames
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shq, sniffImageMediaType } from './hdc.js'

/** Remote scratch directory for frames, writable without root. */
export const FRAME_DIR = '/data/local/tmp/dsh_frames'

/**
 * A remote scratch directory no other capture can be using.
 *
 * Every loop starts by removing its directory and ends by removing it again, so
 * two captures sharing one name delete each other's frames: a second live stream,
 * a screenshot taken while a recording runs, or a reconnect whose old loop is
 * still exiting all produce that collision. A per-run name is what makes the
 * remove-on-entry safe, because it can only ever name this run's own files.
 *
 * The random part matters rather than a timestamp: two runs can start in the
 * same millisecond, and this device's shell offers no better clock.
 *
 * @param kind - what the directory is for, for a readable name on the device.
 * @returns an absolute path under {@link FRAME_DIR}.
 */
export function frameDirFor(kind) {
  return `${FRAME_DIR}/${kind}-${randomUUID()}`
}

/** A frame larger than this is a runaway, not a screenshot. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Ceiling on one live stream, so a loop whose reader vanished still exits. */
const MAX_STREAM_FRAMES = 60 * 60 * 6

/** Ceiling on one recording loop, with slack over the requested seconds. */
const MAX_RECORD_FRAMES = 30 * 180

/**
 * Extra time a recording may spend past its length before it is cut off.
 *
 * A normal run needs this for its final capture to land: one frame costs
 * 0.4–0.7 s on the device, and the stream is asked for its next frame before the
 * length runs out. A run that needs much more than this is not recording: the
 * device stopped producing, and the call must end with a report instead of
 * waiting for a process that will never write again.
 */
const RECORD_GRACE_MS = 5_000

/**
 * How long a single still may wait for its frame.
 *
 * One capture costs 0.4–0.7 s on a healthy device, so this is not a latency
 * budget: it is the point at which a device that accepted the connection and
 * then went quiet must be reported instead of waited on indefinitely.
 */
const CAPTURE_TIMEOUT_MS = 20_000

/**
 * Parallel capture slots for the live picture.
 *
 * One capture costs a fixed ~0.4 s on the device no matter how small the image
 * is: an 8x8 capture still takes ~0.36 s, so the cost is the RenderService
 * round-trip and not the pixels or the JPEG encoder. Captures run in separate
 * processes, so overlapping them raises throughput almost linearly until the
 * device's cores are busy. Measured on a HarmonyOS 7.0.0 phone at 608x1344,
 * 12 frames each:
 *
 *   slots=1  5.83 s  2.06 fps
 *   slots=2  3.50 s  3.43 fps
 *   slots=3  2.28 s  5.26 fps
 *   slots=4  2.16 s  5.56 fps
 *   slots=6  1.98 s  6.06 fps
 *
 * Four is where the curve flattens, and it is also the point past which the
 * device starts to feel the load, so it is the default. `1` reproduces the
 * strictly sequential loop, which is what a recording uses because its frames
 * must land in order.
 */
export const DEFAULT_STREAM_SLOTS = 4

/** A runaway slot count would fork-bomb the device; refuse well before that. */
const MAX_STREAM_SLOTS = 8

/**
 * The `-w`/`-h` suffix for one capture, or nothing when neither side was asked for.
 *
 * Both sides or neither: `snapshot_display` takes the pair as a size, and asking
 * it for one side while silently capturing at full resolution would make a
 * documented option look like it did nothing. A caller that supplies only one
 * gets the refusal here rather than a picture at the wrong size.
 *
 * @param width - requested capture width, or undefined.
 * @param height - requested capture height, or undefined.
 * @returns the flag suffix, or an empty string.
 */
function sizeFlags(width, height) {
  const has = (value) => value !== undefined && value !== null
  if (!has(width) && !has(height)) return ''
  if (!has(width) || !has(height)) {
    const error = new Error('width and height must be given together')
    error.code = 'HDC_BAD_ARGS'
    throw error
  }
  return ` -w ${Math.trunc(width)} -h ${Math.trunc(height)}`
}

/**
 * The remote loop, as one POSIX shell script.
 *
 * Both capture commands are tried per frame, in the same order `captureScreen`
 * uses: `snapshot_display` is preferred and `uitest screenCap` covers builds
 * without it. A frame that neither produced prints `ERROR` and the loop goes
 * on, so one bad capture does not end a whole stream.
 *
 * The loop removes each frame as it goes, so a stream that is killed mid-frame
 * leaves at most one file behind, and it removes its directory on a normal end.
 *
 * @param options.dir - remote scratch directory.
 * @param options.maxFrames - hard stop, so a reader that vanished cannot leak a loop.
 * @param options.width - scaled capture width; omit to capture at device resolution.
 * @param options.height - scaled capture height.
 * @param options.intervalMs - pause after each frame, to bound device CPU.
 * @param options.slots - captures kept in flight at once; 1 is sequential.
 * @returns a POSIX shell script.
 */
export function frameLoopScript(options = {}) {
  const dir = options.dir ?? FRAME_DIR
  const maxFrames = Math.max(1, Math.trunc(options.maxFrames ?? MAX_STREAM_FRAMES))
  const intervalMs = Math.max(0, Math.trunc(options.intervalMs ?? 0))
  const slots = Math.min(MAX_STREAM_SLOTS, Math.max(1, Math.trunc(options.slots ?? DEFAULT_STREAM_SLOTS)))
  const size = sizeFlags(options.width, options.height)
  if (slots <= 1) return sequentialLoopScript({ dir, maxFrames, intervalMs, size })
  return pipelinedLoopScript({ dir, maxFrames, intervalMs, size, slots })
}

/**
 * The probe that picks one capture command for the whole run.
 *
 * The two commands differ by a factor of about eight in cost — `snapshot_display`
 * takes ~0.4 s and writes ~190 KB, `uitest screenCap` takes ~3 s and writes
 * ~2.5 MB — so deciding per frame is the wrong shape: a single unlucky frame
 * under parallel load would drop the stream to a slideshow for several seconds.
 * Which one exists is a property of the build, not of a frame, so it is decided
 * once, up front, and the loop then uses only that command.
 *
 * The probe writes a tiny frame to a throwaway name so its own cost is the same
 * RenderService round trip and nothing more.
 *
 * @returns shell lines that set `CAP` to `jpeg` or `png`.
 */
function probeLines(size) {
  return [
    // `CAP` is the extension and the command together: one variable keeps the
    // loop from re-deciding, and the loop names its file from it.
    // Emit the probe frame directly when `snapshot_display` succeeds so the
    // first frame of a stream or single-frame capture is not paid twice.
    'probe="$d/probe.jpeg"',
    '_probed=0',
    `if snapshot_display -f "$probe"${size} >/dev/null 2>&1 && [ -s "$probe" ]; then`,
    '  CAP=jpeg',
    '  printf \'FRAME %s\\n\' "$(wc -c < "$probe")"',
    '  cat "$probe"',
    '  _probed=1',
    'else',
    '  CAP=png',
    'fi',
    'rm -f "$probe" 2>/dev/null',
  ]
}

/**
 * Capture one frame into slot `$1` according to the probed command.
 *
 * A command that fails this time is *not* retried with the other one: the probe
 * already established which exists, so a failure here is load, a locked screen,
 * or a lost device — none of which the slow command fixes. Emitting nothing lets
 * the reader keep the previous frame, which looks like a dropped frame instead of
 * a multi-second stall.
 *
 * @param options.size - the `-w`/`-h` suffix, or an empty string.
 * @returns one shell function definition.
 */
function captureFunction(size) {
  return [
    'capture() {',
    '  _n=$1',
    `  if [ "$CAP" = jpeg ]; then snapshot_display -f "$d/s$_n.jpeg"${size} >/dev/null 2>&1`,
    `  else uitest screenCap -p "$d/s$_n.png" >/dev/null 2>&1; fi`,
    '}',
  ]
}

/** Emit whatever the given slot captured, or nothing when the capture failed. */
function emitFunction() {
  return [
    'emit() {',
    '  _n=$1',
    '  if [ "$CAP" = jpeg ]; then _f="$d/s$_n.jpeg"; else _f="$d/s$_n.png"; fi',
    '  if [ -s "$_f" ]; then',
    // Single quotes around a line that itself contains single quotes, so the
    // inner `\n` survives as the two characters the shell's printf wants.
    '    printf \'FRAME %s\\n\' "$(wc -c < "$_f")"',
    '    cat "$_f"',
    '  fi',
    '  rm -f "$d/s$_n.jpeg" "$d/s$_n.png" 2>/dev/null',
    '}',
  ]
}

/**
 * One capture at a time: the simple loop, and the shape a recording needs.
 *
 * A recording must emit frames in the order they were taken, and a slot pipeline
 * would reorder them, so it stays sequential.
 */
function sequentialLoopScript({ dir, maxFrames, intervalMs, size }) {
  // A fractional `sleep` is supported by the device's shell, but a zero interval
  // must not call it at all: not every build tolerates `sleep 0`.
  const pause = intervalMs > 0 ? `\n  sleep ${(intervalMs / 1000).toFixed(3)}` : ''
  // Every function is defined before the loop that calls it: a POSIX shell
  // parses and runs a script as it reads it, so a definition placed after its
  // use is not in scope yet.
  return [
    `d=${shq(dir)}`,
    'rm -rf "$d" 2>/dev/null; mkdir -p "$d" || exit 3',
    ...probeLines(size),
    ...captureFunction(size),
    ...emitFunction(),
    'i=$_probed',
    `while [ "$i" -lt ${maxFrames} ]; do`,
    '  capture "$i"',
    '  emit "$i"',
    `  i=$((i+1))${pause}`,
    'done',
    'rm -rf "$d" 2>/dev/null',
  ].join('\n')
}

/**
 * Several captures in flight at once, emitting each as it lands.
 *
 * Each slot owns a file name and a background capture process. The loop waits
 * for the oldest slot, emits it, and immediately restarts it, so exactly `slots`
 * captures stay outstanding after the first round. That is what turns the
 * device's fixed per-capture latency into throughput: one capture takes ~0.4 s,
 * but four overlapped ones deliver a frame every ~0.18 s. Measured on a
 * HarmonyOS 7.0.0 phone, 12 full-resolution frames: 1.5 fps with one slot, 4.1
 * with four.
 *
 * The command is chosen once by the probe, not per frame, so a frame that loses
 * the race for the device is simply skipped: paying the ~3 s PNG path for it
 * would freeze the picture instead of dropping one frame from it.
 *
 * `wait` takes an explicit PID rather than a job spec: the device's `sh` is not
 * an interactive shell, and `wait %1` is not available in it.
 *
 * @returns a POSIX shell script.
 */
function pipelinedLoopScript({ dir, maxFrames, intervalMs, size, slots }) {
  const pause = intervalMs > 0 ? `\n  sleep ${(intervalMs / 1000).toFixed(3)}` : ''
  return [
    `d=${shq(dir)}`,
    'rm -rf "$d" 2>/dev/null; mkdir -p "$d" || exit 3',
    ...probeLines(size),
    ...captureFunction(size),
    ...emitFunction(),
    // `capture` starts a background process for slot $1 and remembers its PID.
    'start() {',
    '  capture "$1" &',
    '  eval "pid$1=$!"',
    '}',
    `count=$((${maxFrames} - _probed))`,
    // Prime every slot, but never start more captures than frames wanted.
    'i=0',
    `while [ "$i" -lt ${slots} ] && [ "$i" -lt "$count" ]; do start "$i"; i=$((i+1)); done`,
    'i=0',
    'while [ "$i" -lt "$count" ]; do',
    `  k=$((i % ${slots}))`,
    // The backslash matters: without it, `$pid$k` expands both variables
    // before `eval` runs and the indirection is lost (evaluating `pid0=1234`
    // as `_p=1234` then `echo $_p` prints the index, not the PID). Escaping
    // `$pid` defers its expansion, so `eval` sees `_p=${pid0}` and reads the
    // variable whose name was just built.
    '  eval "_p=\\$pid$k"',
    // A slot only holds a PID while a capture for it is outstanding; once the
    // frame count is smaller than the slot count the tail slots have none.
    '  if [ -n "$_p" ]; then',
    '    wait "$_p"',
    '    emit "$k"',
    `    _next=$((i + ${slots}))`,
    '    if [ "$_next" -lt "$count" ]; then',
    '      start "$k"',
    '    else',
    '      eval "pid$k="',
    '    fi',
    '  fi',
    `  i=$((i+1))${pause}`,
    'done',
    // Let any capture still running finish before the directory goes away.
    'wait',
    'rm -rf "$d" 2>/dev/null',
  ].join('\n')
}

/**
 * Split a `hdc shell` byte stream into frames.
 *
 * Yields one image per `FRAME <bytes>` line. Any other line is dropped: a device
 * prints banners and errors around the loop, and neither is a frame. A `[Fail]`
 * line is the exception — it is remembered on `options.diagnostic` instead,
 * because it is the only explanation a disconnected or refusing device gives.
 * `hdc` prints those to **stdout**, not stderr, so a caller that only watches
 * stderr reports "no frame" with no cause at all.
 *
 * A frame cut short at the end of the stream is discarded rather than yielded.
 * A truncated image renders as a broken picture, which reads as a device fault
 * instead of an interrupted read.
 *
 * An implausible size ends the stream rather than being skipped. Once a header
 * is untrustworthy the payload cannot be skipped either: a JPEG contains `0x0a`
 * bytes, so there is no delimiter to resynchronise on, and every later "header"
 * would be read out of picture data. A real device cannot produce one, so
 * stopping is both safe and the only honest answer.
 *
 * @param chunks - async iterable of Buffers, normally a child process's stdout.
 * @param options.sniff - image-type sniffer, injectable for tests.
 * @param options.diagnostic - set to a mutable object to receive the first
 *   `[Fail]` line, so the caller can report why nothing was captured.
 * @yields `{ data, mediaType, at }` for each complete frame.
 */
/**
 * Incremental byte queue avoiding O(n^2) Buffer.concat on every incoming chunk.
 */
function createChunkBuffer() {
  const queue = []
  let total = 0

  const consume = (n) => {
    if (n <= 0) return Buffer.alloc(0)
    if (queue.length === 1 && queue[0].length === n) {
      total -= n
      return queue.shift()
    }
    if (queue[0].length > n) {
      const slice = Buffer.from(queue[0].subarray(0, n))
      queue[0] = queue[0].subarray(n)
      total -= n
      return slice
    }
    const parts = []
    let remaining = n
    while (remaining > 0) {
      const head = queue[0]
      if (head.length <= remaining) {
        parts.push(head)
        remaining -= head.length
        queue.shift()
      } else {
        parts.push(head.subarray(0, remaining))
        queue[0] = head.subarray(remaining)
        remaining = 0
      }
    }
    total -= n
    return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, n)
  }

  const skip = (n) => {
    let remaining = n
    total -= n
    while (remaining > 0) {
      const head = queue[0]
      if (head.length <= remaining) {
        remaining -= head.length
        queue.shift()
      } else {
        queue[0] = head.subarray(remaining)
        remaining = 0
      }
    }
  }

  const indexOfByte = (byte) => {
    let offset = 0
    for (const chunk of queue) {
      const idx = chunk.indexOf(byte)
      if (idx >= 0) return offset + idx
      offset += chunk.length
    }
    return -1
  }

  const readUtf8Line = (newlineOffset) => {
    if (newlineOffset === 0) {
      skip(1)
      return ''
    }
    if (queue[0].length > newlineOffset) {
      const text = queue[0].subarray(0, newlineOffset).toString('utf8')
      if (queue[0].length === newlineOffset + 1) queue.shift()
      else queue[0] = queue[0].subarray(newlineOffset + 1)
      total -= newlineOffset + 1
      return text
    }
    const lineBuf = consume(newlineOffset)
    skip(1)
    return lineBuf.toString('utf8')
  }

  return {
    get length() {
      return total
    },
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (buf.length === 0) return
      queue.push(buf)
      total += buf.length
    },
    indexOfByte,
    readUtf8Line,
    consume,
  }
}

export async function* readFrames(chunks, options = {}) {
  const sniff = options.sniff ?? sniffImageMediaType
  const diagnostic = options.diagnostic
  const buf = createChunkBuffer()
  let pendingSize
  for await (const chunk of chunks) {
    buf.push(chunk)
    for (;;) {
      if (pendingSize === undefined) {
        const newline = buf.indexOfByte(0x0a)
        if (newline < 0) break
        const line = buf.readUtf8Line(newline).trim()
        const declared = /^FRAME (\d+)$/u.exec(line)
        if (declared === null) {
          if (diagnostic !== undefined && diagnostic.text === undefined && /^\[Fail\]/u.test(line)) {
            diagnostic.text = line
          }
          continue
        }
        const size = Number(declared[1])
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FRAME_BYTES) return
        pendingSize = size
      }
      if (buf.length < pendingSize) break
      const data = buf.consume(pendingSize)
      pendingSize = undefined
      // The bytes decide the type, not the file name the device wrote to.
      const mediaType = sniff(data)
      // A capture command that wrote an error page instead of an image is not a
      // frame; skipping it keeps a broken <img> out of the panel.
      if (mediaType !== undefined) yield { data, mediaType, at: Date.now() }
    }
  }
}

/**
 * Latest frame per serial from any active live stream (full-resolution only).
 * Used by `captureStill` to avoid a redundant device capture when a stream is
 * already delivering fresh frames.
 */
const activeStreamLatest = new Map()

/** Return a recent full-resolution frame from an active stream, if fresh enough. */
export function latestStreamFrame(serial, maxAgeMs = 450) {
  const entry = activeStreamLatest.get(serial)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > maxAgeMs) return undefined
  return { data: entry.frame.data, mediaType: entry.frame.mediaType, at: entry.frame.at }
}

/** Wrap a stream so full-resolution frames populate `activeStreamLatest`. */
export function trackStreamLatest(serial, stream) {
  const token = Symbol('stream')
  const inner = stream.frames
  const frames = (async function* () {
    try {
      for await (const frame of inner) {
        activeStreamLatest.set(serial, { token, frame, at: Date.now() })
        yield frame
      }
    } finally {
      const current = activeStreamLatest.get(serial)
      if (current?.token === token) activeStreamLatest.delete(serial)
    }
  })()
  return {
    ...stream,
    frames,
    stop() {
      const current = activeStreamLatest.get(serial)
      if (current?.token === token) activeStreamLatest.delete(serial)
      stream.stop()
    },
  }
}

/**
 * Start the remote capture loop over one `hdc shell` connection.
 *
 * `stop` is the only correct way to end a stream: it kills the local client,
 * whose pipe closing makes the remote loop exit on its next write. `maxFrames`
 * is the backstop for a connection that outlives its reader without noticing.
 *
 * @returns the frame iterator, the child, and what ended it.
 */
export function openFrameStream(hdcPath, serial, options = {}) {
  const child = spawn(hdcPath, ['-t', serial, 'shell', frameLoopScript(options)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    // Bounded: a device that rejects the command prints a long usage text, and
    // only the first line of it reaches a failure message.
    if (stderr.length < 4096) stderr += chunk
  })
  child.stdout.on('error', () => {})
  let exited = false
  const done = new Promise((resolve) => {
    child.once('error', (error) => {
      exited = true
      if (stderr === '') stderr = String(error.message ?? error)
      resolve()
    })
    child.once('close', () => {
      exited = true
      resolve()
    })
  })
  // `hdc` prints its own failures to stdout, so the parser collects them; this
  // is what lets a failed capture name its cause instead of saying "no frame".
  const diagnostic = { text: undefined }
  const trackLatest = options.width === undefined && options.height === undefined && options.maxFrames === undefined
  const token = Symbol('stream')
  const rawFrames = readFrames(child.stdout, { ...options, diagnostic })
  const frames = !trackLatest ? rawFrames : (async function* () {
    try {
      for await (const frame of rawFrames) {
        activeStreamLatest.set(serial, { token, frame, at: Date.now() })
        yield frame
      }
    } finally {
      const current = activeStreamLatest.get(serial)
      if (current?.token === token) activeStreamLatest.delete(serial)
    }
  })()
  return {
    child,
    frames,
    done,
    /** Why nothing was captured, from stderr or from a `[Fail]` on stdout. */
    get stderr() {
      const stdoutFailure = diagnostic.text
      if (stderr.trim() !== '') return stderr.trim() === '' || stdoutFailure === undefined ? stderr : `${stderr}\n${stdoutFailure}`
      return stdoutFailure ?? stderr
    },
    get exited() {
      return exited
    },
    /**
     * End the stream now.
     *
     * Killing the client is not enough on its own: the stdout pipe is shared
     * with the remote loop's descendants, so a grandchild that inherited it can
     * hold the pipe open and leave `for await` waiting on a reader that will
     * never see another byte. Destroying the pipe is what releases the reader;
     * the kill is what stops the capture work on the device.
     */
    stop() {
      const current = activeStreamLatest.get(serial)
      if (current?.token === token) activeStreamLatest.delete(serial)
      if (!exited) child.kill('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
    },
  }
}

/**
 * Decode the pixel size of a PNG or JPEG frame.
 *
 * The panel reports it under the picture, and a recording reports it so a caller
 * knows whether the capture was scaled.
 */
export function imageSize(data) {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]
      // SOF0…SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) hold
      // other tables under the same marker range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) }
      }
      const length = data.readUInt16BE(offset + 2)
      if (length <= 0) return undefined
      offset += 2 + length
    }
  }
  return undefined
}

/** Where `ffmpeg` usually is when it is not on PATH. */
const FFMPEG_PATHS = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
]

/**
 * Locate `ffmpeg`, which is what joins a frame sequence into a playable mp4.
 *
 * Searched on every call, so installing it takes effect without a restart. It is
 * never required: without it a recording is kept as its frame sequence, which
 * any video tool can encode later.
 */
export function discoverFfmpeg(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const expanded = configured.trim().replace(/^~(?=\/)/u, os.homedir())
    if (existsSync(expanded)) return expanded
  }
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const candidate of FFMPEG_PATHS) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Run one local process to completion, bounded and cancellable, and report how
 * it ended.
 *
 * `signal` matters here because encoding a long recording is the slowest step
 * after the capture itself: without it, cancelling a recording during encoding
 * left ffmpeg running for its full timeout and then still produced a file the
 * caller had already abandoned.
 */
function runTool(command, argv, { timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve({ ok: false, cancelled: true, stderr: 'the call was cancelled' })
      return
    }
    // `detached` puts the child in its own process group, so the group kill
    // below reaches everything it started.
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stderr = ''
    // Killing the process group is what actually stops the work: an ffmpeg
    // wrapper (or any shell script) spawns a child that inherits the pipes, so
    // signalling only the direct child leaves the real encoder running and this
    // promise waiting on a pipe it never closes.
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(kill, timeoutMs)
    const onAbort = () => kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (outcome) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    child.stdout.on('data', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk
    })
    child.once('error', (error) => {
      finish({ ok: false, cancelled: signal?.aborted === true, stderr: `${stderr}${String(error.message ?? error)}` })
    })
    child.once('close', (code) => {
      finish({ ok: code === 0, cancelled: signal?.aborted === true, stderr })
    })
  })
}

/**
 * Join a numbered frame sequence into an mp4.
 *
 * `yuv420p` and the even-dimension scale are what make the file play in a
 * browser: H.264 at 4:2:0 cannot encode an odd width or height, and an odd
 * capture size is a real possibility on an unusual display. `+faststart` moves
 * the index to the front so the file streams instead of downloading first.
 *
 * The input is the numbered `frame%05d.jpg` form rather than a glob. The
 * image2 demuxer reads either, but `-pattern_type glob` needs a build with the
 * glob demuxer compiled in, and the stock macOS homebrew ffmpeg (9.0.2) does
 * not have it — it fails with "Error opening input file". The numeric pattern
 * works on every build, and the caller names the frames to match it. The `.jpg`
 * suffix does not constrain the content: the demuxer sniffs each file, so a PNG
 * frame numbered `.jpg` still decodes.
 *
 * @returns whether the file was produced, and ffmpeg's own words when it was not.
 */
async function encodeMp4(ffmpegPath, framesDir, fps, outPath, signal) {
  const outcome = await runTool(ffmpegPath, [
    '-y',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame%05d.jpg'),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath,
  ], { signal })
  // A cancelled encode is not a failed encode: the caller asked to stop, so the
  // half-written file is removed and the cancel is reported rather than turned
  // into "ffmpeg refused".
  if (outcome.cancelled === true || signal?.aborted === true) {
    await rm(outPath, { force: true }).catch(() => {})
    return { ok: false, cancelled: true, detail: 'the recording was cancelled while it was being encoded' }
  }
  if (outcome.ok) return { ok: true }
  await rm(outPath, { force: true }).catch(() => {})
  const detail = outcome.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
  return { ok: false, detail }
}

/**
 * Record the screen for a bounded number of seconds.
 *
 * The playback rate is the rate the frames actually arrived at, clamped to
 * [1, 30]: a device that stalled for half a second would otherwise turn the
 * recording into a slideshow, and one that burst would fast-forward it. Both are
 * real behaviours at this cadence, and neither should change the duration of the
 * file relative to the recording.
 *
 * @param options.seconds - how long to record.
 * @param options.savePath - local destination; `.mp4` when ffmpeg is available.
 * @param options.ffmpegPath - encoder to use, or `undefined` to keep frames only.
 * @param options.width - scaled capture width; omit for device resolution.
 * @param options.height - scaled capture height.
 * @param options.signal - aborts the recording, leaving no partial file.
 * @returns the saved path, its kind (`video` or `frames`), and what was captured.
 */
export async function recordScreen(hdcPath, serial, options) {
  const { seconds, savePath, signal, ffmpegPath } = options
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-hdc-rec-'))
  const stream = openFrameStream(hdcPath, serial, {
    dir: frameDirFor('rec'),
    maxFrames: Math.min(MAX_RECORD_FRAMES, Math.max(2, seconds * 30 + 10)),
    width: options.width,
    height: options.height,
    intervalMs: options.intervalMs,
    // A recording must stay in order: a slot pipeline emits whichever capture
    // finished first, which would scramble the sequence and make the video jump
    // backwards. The live picture is the one that wants the throughput.
    slots: 1,
  })
  const onAbort = () => stream.stop()
  if (signal !== undefined && !signal.aborted) signal.addEventListener('abort', onAbort)
  if (signal?.aborted === true) stream.stop()

  // The deadline is a timer, not a check inside the loop. Checking only when a
  // frame arrives means a device that stops producing — a hung capture, a lost
  // link whose process never exits — keeps the call pending for as long as the
  // process lives, so `seconds` would bound nothing at all. The grace period is
  // what a normal run needs for its last capture to land.
  const deadlineMs = seconds * 1000 + RECORD_GRACE_MS
  let deadlineExpired = false
  const deadline = setTimeout(() => {
    deadlineExpired = true
    stream.stop()
  }, deadlineMs)

  let written = 0
  let size
  const pendingWrites = []
  const started = Date.now()
  try {
    for await (const frame of stream.frames) {
      // A slow first capture can overrun the requested length; the deadline is
      // what the caller asked for.
      if (Date.now() - started >= seconds * 1000) break
      written += 1
      size ??= imageSize(frame.data)
      // One name pattern, whatever the frame's real type: ffmpeg's numeric
      // input sequence cannot span two extensions, and it sniffs the content
      // anyway, so a PNG frame stored as `.jpg` still decodes correctly.
      // Write without blocking the stream reader so stdout keeps draining.
      const framePath = path.join(dir, `frame${String(written).padStart(5, '0')}.jpg`)
      pendingWrites.push(writeFile(framePath, frame.data))
    }
    await Promise.all(pendingWrites)
  } catch (error) {
    // `stop()` destroys the pipe, which surfaces here as a premature close. That
    // is this module ending the read on purpose — the deadline or a cancel — not
    // a failure, so it must not escape past the cleanup below. Anything else is
    // a real read error and still propagates.
    if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  } finally {
    clearTimeout(deadline)
    stream.stop()
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
  await stream.done.catch(() => {})

  if (signal?.aborted === true) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    const error = new Error('the recording was cancelled')
    error.code = 'HDC_RECORD_CANCELLED'
    throw error
  }
  if (written === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    const detail = stream.stderr.trim() === '' ? '' : `: ${stream.stderr.trim().split('\n')[0]}`
    // A stream cut off by the deadline never wrote a frame: that is a device
    // that stopped answering, and saying so is more useful than "no frame".
    const message = deadlineExpired
      ? `the device stopped producing frames; no frame arrived within ${Math.round(deadlineMs / 1000)} s${detail}`
      : `no frame could be captured from the device${detail}`
    const error = new Error(message)
    error.code = deadlineExpired ? 'HDC_RECORD_TIMEOUT' : 'HDC_CAPTURE_FAILED'
    throw error
  }

  const elapsed = Math.max(0.5, (Date.now() - started) / 1000)
  const fps = Math.min(30, Math.max(1, Math.round((written / elapsed) * 10) / 10))

  // Everything from here on can fail on the filesystem — a full disk, a target
  // whose parent is not a directory, a frame that cannot be copied — and every
  // one of those used to leave the captured frames in the system temp directory
  // for the rest of the session. One scope now decides their fate: the temp
  // directory is removed on every exit, and only a frame sequence this call
  // successfully claimed survives, because `keepFrames` moves it out first.
  try {
    await mkdir(path.dirname(savePath), { recursive: true })

    if (ffmpegPath !== undefined) {
      const encoded = await encodeMp4(ffmpegPath, dir, fps, savePath, signal)
      if (encoded.cancelled === true) {
        const error = new Error('the recording was cancelled')
        error.code = 'HDC_RECORD_CANCELLED'
        throw error
      }
      if (encoded.ok) {
        return {
          savedPath: savePath,
          kind: 'video',
          frames: written,
          fps,
          seconds: Math.round(elapsed * 10) / 10,
          bytes: (await stat(savePath)).size,
          ...size === undefined ? {} : { size },
        }
      }
      // Keeping the frames beats failing: they are the recording, and any video
      // tool can encode them once ffmpeg is sorted out. A cancel is the one case
      // that keeps nothing: the caller no longer wants the result.
      if (signal?.aborted === true) {
        const error = new Error('the recording was cancelled')
        error.code = 'HDC_RECORD_CANCELLED'
        throw error
      }
      const kept = await keepFrames(dir, savePath)
      return {
        ...kept,
        kind: 'frames',
        frames: written,
        fps,
        seconds: Math.round(elapsed * 10) / 10,
        ...size === undefined ? {} : { size },
        note: encoded.detail,
      }
    }
    const kept = await keepFrames(dir, savePath)
    return {
      ...kept,
      kind: 'frames',
      frames: written,
      fps,
      seconds: Math.round(elapsed * 10) / 10,
      ...size === undefined ? {} : { size },
    }
  } finally {
    // `keepFrames` has already removed this directory and moved its files, so a
    // sequence that succeeded is not touched here; a failure of any kind is.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The frame-directory names one recording may claim, in the order they are tried.
 *
 * The first is the documented `-frames` name beside the requested path. The
 * numbered forms are what a second recording falls back to, so a name that is
 * already taken is never reused.
 */
function frameTargets(savePath, limit = 100) {
  const base = `${savePath.replace(/\.[^./\\]+$/u, '')}-frames`
  const candidates = [base]
  for (let index = 2; index <= limit; index += 1) candidates.push(`${base}-${index}`)
  return candidates
}

/**
 * Keep a frame sequence when no video could be made.
 *
 * The frames are moved beside the requested path under a `-frames` suffix, still
 * numbered, so a later run can encode them without re-recording.
 *
 * An existing directory is never removed or merged into. A path the user
 * already owns may hold anything at all, so the only safe use of it is to leave
 * it alone: the next free numbered name is claimed instead, and `mkdir` without
 * `recursive` is what makes the claim atomic. The previous version deleted the
 * whole target first, which destroyed unrelated files that happened to sit in
 * `<name>-frames`.
 *
 * The directory is created before any frame is copied, and removed again when a
 * copy fails, so a failed run leaves neither a partial sequence nor a name
 * claimed for nothing.
 */
async function keepFrames(dir, savePath) {
  let target
  for (const candidate of frameTargets(savePath)) {
    try {
      await mkdir(candidate)
      target = candidate
      break
    } catch (error) {
      // A taken name is the normal case for a rerun: try the next one.
      if (error?.code !== 'EEXIST') throw error
    }
  }
  if (target === undefined) {
    const error = new Error(`could not find a free directory name beside ${savePath}`)
    error.code = 'HDC_RECORD_FAILED'
    throw error
  }
  try {
    let bytes = 0
    for (const name of (await readdir(dir)).sort()) {
      const source = path.join(dir, name)
      bytes += (await stat(source)).size
      await copyFile(source, path.join(target, name))
    }
    return { savedPath: target, bytes }
  } catch (error) {
    // Only a directory this call created is removed, which is why the claim
    // above had to be exclusive.
    await rm(target, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Capture one frame at device resolution, as PNG when the device offers it.
 *
 * This is the panel's 截图: a still of the live picture, at full size, which is
 * also what a `hdc_screenshot` call returns. It reads the same frame stream as
 * everything else, so there is one capture path and one set of failure modes.
 *
 * @returns the image bytes and their type.
 */
export async function captureFrame(hdcPath, serial, options = {}) {
  const { signal } = options
  const stream = openFrameStream(hdcPath, serial, {
    dir: frameDirFor('shot'),
    maxFrames: 1,
    width: options.width,
    height: options.height,
  })
  // A capture is also bounded in time: a device that accepts the connection but
  // never writes a frame would otherwise hold the caller, the pipe and the
  // child process for as long as the process lives.
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    stream.stop()
  }, options.timeoutMs ?? CAPTURE_TIMEOUT_MS)
  const onAbort = () => stream.stop()
  if (signal !== undefined) {
    if (signal.aborted) stream.stop()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    for await (const frame of stream.frames) {
      return { data: frame.data, mediaType: frame.mediaType, at: frame.at }
    }
  } catch (error) {
    // Stopping the stream destroys its pipe, which surfaces here as a premature
    // close. That is this function ending the read on purpose, not a read error.
    if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', onAbort)
    stream.stop()
  }
  await stream.done.catch(() => {})
  if (signal?.aborted === true) {
    const error = new Error('the screenshot was cancelled')
    error.code = 'HDC_RECORD_CANCELLED'
    throw error
  }
  const detail = stream.stderr.trim() === '' ? '' : `: ${stream.stderr.trim().split('\n')[0]}`
  const error = new Error(timedOut
    ? `the device did not produce a frame within ${Math.round(CAPTURE_TIMEOUT_MS / 1000)} s${detail}`
    : `the device produced no frame${detail}`)
  error.code = 'HDC_SCREENSHOT_FAILED'
  throw error
}

