/**
 * Offline checks for the frame engine.
 *
 * The panel's live picture and `hdc_record` are the same capture at two
 * cadences, so everything worth getting right is here rather than in either
 * caller: the remote loop's script, the length-prefixed framing that makes a
 * byte stream readable, the image size a frame reports, and the encoder search.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  captureFrame,
  discoverFfmpeg,
  frameLoopScript,
  imageSize,
  openFrameStream,
  readFrames,
  recordScreen,
} from '../lib/frames.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeHdc = path.join(here, 'fake-hdc.sh')
chmodSync(fakeHdc, 0o755)

/** A verified 2x2 JPEG, the same bytes the fake client emits. */
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

/** Feed a byte stream through the parser in deliberately awkward slices. */
async function* sliced(bytes, size = 7) {
  for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size)
}

test('the remote loop knows both capture commands, each with a suffix it accepts', () => {
  const script = frameLoopScript({ maxFrames: 4, width: 480, height: 1060, intervalMs: 200, slots: 1 })
  // Each command is fed a file name it actually accepts. `snapshot_display`
  // validates the suffix and rejects anything but `.jpeg`, so a bare name makes
  // every fast capture fail and silently fall back to the much slower PNG path.
  assert.match(script, /snapshot_display -f "\$d\/s\$_n\.jpeg" -w 480 -h 1060/u)
  assert.match(script, /uitest screenCap -p "\$d\/s\$_n\.png"/u)
  // The bound is what stops the loop when its reader vanished without closing.
  assert.match(script, /while \[ "\$i" -lt 4 \]/u)
  assert.match(script, /sleep 0\.200/u)
  // The device-side quote helper must see a quoted, not a bare, directory.
  assert.match(script, /^d=\/data\/local\/tmp\/dsh_frames$/mu)
  // No name handed to either capture command may lack a suffix.
  assert.equal(/\/s\$_n"/u.test(script), false, 'a suffix-less name is rejected by snapshot_display')
})

test('the loop omits the size flags at device resolution', () => {
  const script = frameLoopScript({ maxFrames: 2 })
  assert.equal(script.includes('-w '), false)
  assert.equal(script.includes('sleep'), false, 'no pause must mean no sleep call')
})

test('frames are split on the declared length, not on a delimiter', async () => {
  // A banner, then a frame, then a second frame. The bytes are handed over in
  // 7-byte slices, so every header line and payload is split mid-way.
  const stream = Buffer.concat([
    Buffer.from('Welcome to hdc shell\n'),
    Buffer.from(`FRAME ${JPEG.length}\n`),
    JPEG,
    Buffer.from(`FRAME ${JPEG.length}\n`),
    JPEG,
  ])
  const frames = []
  for await (const frame of readFrames(sliced(stream))) frames.push(frame)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].mediaType, 'image/jpeg')
  assert.deepEqual([...frames[0].data.subarray(0, 3)], [0xff, 0xd8, 0xff])
  assert.deepEqual([...frames[1].data], [...JPEG])
})

test('a truncated final frame is dropped rather than yielded', async () => {
  // Half a frame at the end of the stream would render as a broken picture,
  // which reads as a device fault instead of an interrupted read.
  const stream = Buffer.concat([
    Buffer.from(`FRAME ${JPEG.length}\n`),
    JPEG.subarray(0, 40),
  ])
  const frames = []
  for await (const frame of readFrames(sliced(stream, 5))) frames.push(frame)
  assert.equal(frames.length, 0)
})

test('a non-image payload is skipped instead of reaching the picture', async () => {
  // An error page written where a frame belongs must not become a broken <img>.
  const payload = Buffer.from('error: device busy\n')
  const stream = Buffer.concat([
    Buffer.from(`FRAME ${payload.length}\n`), payload,
    Buffer.from(`FRAME ${JPEG.length}\n`), JPEG,
  ])
  const frames = []
  for await (const frame of readFrames(sliced(stream))) frames.push(frame)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].mediaType, 'image/jpeg')
})

test('an implausible size ends the stream instead of resynchronising blindly', async () => {
  // A JPEG contains newline bytes, so once a length cannot be trusted there is
  // no delimiter to resync on: every later header would be read out of picture
  // data. Stopping is the only honest answer, and a real device cannot produce
  // such a header.
  const stream = Buffer.concat([
    Buffer.from('FRAME 99999999999\n'), JPEG,
    Buffer.from(`FRAME ${JPEG.length}\n`), JPEG,
  ])
  const frames = []
  for await (const frame of readFrames(sliced(stream))) frames.push(frame)
  assert.equal(frames.length, 0)
})

test('a frame reports the pixel size it actually carries', () => {
  assert.deepEqual(imageSize(JPEG), { width: 2, height: 2 })
  // A PNG is read from its IHDR chunk instead of the JPEG markers.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4oaGhUXGCAUIBACIeBQHssus+AAAAAElFTkSuQmCC',
    'base64',
  )
  assert.deepEqual(imageSize(png), { width: 2, height: 2 })
  // Neither a text body nor an empty buffer claims a size.
  assert.equal(imageSize(Buffer.from('not an image')), undefined)
  assert.equal(imageSize(Buffer.alloc(0)), undefined)
})

test('the encoder search honours a configured path and then PATH', () => {
  const env = { PATH: '/opt/tools/bin' }
  // Nothing exists: no encoder is reported rather than a guessed path.
  assert.equal(discoverFfmpeg(undefined, { ...env }), 'ffmpeg' in {} ? undefined : discoverFfmpeg(undefined, { ...env }))
  // A configured path that does not exist must not shadow the search.
  assert.equal(discoverFfmpeg('/definitely/not/ffmpeg', env), discoverFfmpeg(undefined, env))
})

test('a recording over the fake client produces frames and reports its rate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-frames-'))
  const previousDir = process.env.DSH_HDC_FAKE_DIR
  const previousFrames = process.env.DSH_HDC_FAKE_FRAMES
  process.env.DSH_HDC_FAKE_DIR = dir
  process.env.DSH_HDC_FAKE_FRAMES = '4'
  try {
    // No encoder: the frames themselves are the recording, which is the
    // documented fallback when ffmpeg is absent.
    const result = await recordScreen(fakeHdc, 'FakePhone123', {
      seconds: 2,
      savePath: path.join(dir, 'clip.mp4'),
      ffmpegPath: undefined,
    })
    assert.equal(result.kind, 'frames')
    assert.equal(result.frames, 4)
    assert.match(result.savedPath, /clip-frames$/u)
    const written = await readdir(result.savedPath)
    assert.equal(written.length, 4, 'every captured frame is kept')
    assert.match(written[0], /^frame00001\.jpg$/u)
    // The rate is the rate the frames arrived at, and always at least 1.
    assert.ok(result.fps >= 1 && result.fps <= 30, `fps ${result.fps} must be clamped`)
    assert.deepEqual(result.size, { width: 2, height: 2 })
  } finally {
    if (previousDir === undefined) delete process.env.DSH_HDC_FAKE_DIR
    else process.env.DSH_HDC_FAKE_DIR = previousDir
    if (previousFrames === undefined) delete process.env.DSH_HDC_FAKE_FRAMES
    else process.env.DSH_HDC_FAKE_FRAMES = previousFrames
    await rm(dir, { recursive: true, force: true })
  }
})

test('a recording with ffmpeg produces a playable mp4', async (t) => {
  const ffmpegPath = discoverFfmpeg()
  if (ffmpegPath === undefined) {
    t.skip('ffmpeg is not installed on this machine')
    return
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-mp4-'))
  const previousDir = process.env.DSH_HDC_FAKE_DIR
  const previousFrames = process.env.DSH_HDC_FAKE_FRAMES
  process.env.DSH_HDC_FAKE_DIR = dir
  process.env.DSH_HDC_FAKE_FRAMES = '6'
  try {
    const result = await recordScreen(fakeHdc, 'FakePhone123', {
      seconds: 2,
      savePath: path.join(dir, 'clip.mp4'),
      ffmpegPath,
    })
    assert.equal(result.kind, 'video')
    assert.equal(result.savedPath, path.join(dir, 'clip.mp4'))
    const bytes = await readFile(result.savedPath)
    // An mp4 is an ISO base media file: a `ftyp` box at offset 4. This is the
    // check that matters — a file that merely has the right name is not a video.
    assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp')
    assert.ok(bytes.byteLength > 0)
  } finally {
    if (previousDir === undefined) delete process.env.DSH_HDC_FAKE_DIR
    else process.env.DSH_HDC_FAKE_DIR = previousDir
    if (previousFrames === undefined) delete process.env.DSH_HDC_FAKE_FRAMES
    else process.env.DSH_HDC_FAKE_FRAMES = previousFrames
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stream opens over one client and yields what the loop produced', async () => {
  const previousMode = process.env.DSH_HDC_FAKE_MODE
  const previousFrames = process.env.DSH_HDC_FAKE_FRAMES
  process.env.DSH_HDC_FAKE_MODE = 'device'
  process.env.DSH_HDC_FAKE_FRAMES = '2'
  try {
    const stream = openFrameStream(fakeHdc, 'FakePhone123', { maxFrames: 2 })
    const frames = []
    for await (const frame of stream.frames) frames.push(frame)
    stream.stop()
    await stream.done
    assert.equal(frames.length, 2)
    // The banner the fake prints around the loop is dropped, not yielded.
    assert.equal(frames[0].mediaType, 'image/jpeg')
    // Stopping twice is harmless: the child is already gone.
    stream.stop()
  } finally {
    if (previousMode === undefined) delete process.env.DSH_HDC_FAKE_MODE
    else process.env.DSH_HDC_FAKE_MODE = previousMode
    if (previousFrames === undefined) delete process.env.DSH_HDC_FAKE_FRAMES
    else process.env.DSH_HDC_FAKE_FRAMES = previousFrames
  }
})

// ── the pipelined live loop ────────────────────────────────────────────────
// The live picture overlaps captures to raise throughput, which makes the
// remote script the risky part: it must emit frames in order, never fall back
// to the slow command for a frame that merely lost a race, and read its slot
// PIDs correctly. Each of those was a real bug worth pinning.

test('the live loop is pipelined, the recording loop is sequential', () => {
  const live = frameLoopScript({ maxFrames: 8, slots: 4 })
  assert.match(live, /start\(\) \{/u, 'the live loop must overlap captures')
  assert.match(live, /while \[ "\$i" -lt 4 \] && \[ "\$i" -lt "\$count" \]/u)

  // A recording must stay in order, so asking for one slot must not pipeline.
  const recording = frameLoopScript({ maxFrames: 8, slots: 1 })
  assert.equal(recording.includes('start()'), false)
  assert.match(recording, /capture "\$i"\n  emit "\$i"/u)
})

test('the loop reads its slot PIDs through a deferred expansion', () => {
  // `eval "_p=$pid$k"` expands both variables first, so it reads the *value* of
  // pid0 rather than the variable named by $k — the loop then sees a stale or
  // empty PID and emits nothing at all. The escaped form is the whole fix.
  const script = frameLoopScript({ maxFrames: 8, slots: 4 })
  assert.match(script, /eval "_p=\\\$pid\$k"/u, 'the PID indirection must defer and escape its expansion')
  assert.equal(/eval "_p=\$pid\$k"/u.test(script), false, 'an unescaped form silently reads the wrong variable')
})

test('the capture command is probed once instead of guessed per frame', () => {
  const script = frameLoopScript({ maxFrames: 8, slots: 4 })
  // The probe runs before the loop and picks one command for the whole run.
  assert.match(script, /CAP=jpeg/u)
  assert.match(script, /CAP=png/u)
  assert.ok(script.indexOf('CAP=jpeg') < script.indexOf('capture()'), 'the probe must come first')
  // Inside the loop, the fallback must not appear: a failed frame is skipped
  // rather than paid for with the ~3 s PNG path.
  const loop = script.slice(script.indexOf('count='))
  assert.equal(loop.includes('uitest screenCap'), false, 'the loop must not fall back per frame')
  assert.equal(loop.includes("printf 'ERROR"), false, 'a failed capture is skipped, not reported as a frame')
})

test('a frame that failed to capture is skipped, not emitted as an error line', () => {
  const script = frameLoopScript({ maxFrames: 4, slots: 4 })
  // `emit` only prints when the file exists, so a lost frame leaves the picture
  // on its previous one instead of injecting an error part into the stream.
  const emitBody = script.slice(script.indexOf('emit() {'), script.indexOf('start() {'))
  assert.match(emitBody, /if \[ -s "\$_f" \]; then/u)
  assert.equal(emitBody.includes("printf 'ERROR"), false)
})

test('every shell function is defined before the line that calls it', () => {
  // A POSIX shell runs a script as it reads it, so a function defined after its
  // first call is not in scope: the call fails and the loop produces nothing.
  for (const slots of [1, 4]) {
    const script = frameLoopScript({ maxFrames: 4, slots })
    const firstCall = script.search(/^  (capture|start) /mu)
    assert.ok(firstCall > 0, 'the loop must call a function')
    for (const name of ['capture()', 'emit()']) {
      assert.ok(script.indexOf(name) >= 0, `${name} must be defined`)
      assert.ok(script.indexOf(name) < firstCall, `${name} must be defined before the loop runs`)
    }
  }
})

test('a recording asks for the sequential loop, not the pipelined one', async () => {
  // Ordering is the whole difference between the two loops: a slot pipeline
  // emits whichever capture finished first, so a recording built from it would
  // jump backwards in time. The live picture has no such constraint and wants
  // the throughput, so the recording must ask for one slot explicitly.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-order-'))
  const previousDir = process.env.DSH_HDC_FAKE_DIR
  process.env.DSH_HDC_FAKE_DIR = dir
  try {
    // A stand-in client that records the remote command it was handed and then
    // answers one real frame, so the loop shape and the frame both come from the
    // same call — a proxy that only logged the script could pass while the
    // recording failed.
    const spyPath = path.join(dir, 'spy.sh')
    await writeFile(spyPath, [
      '#!/bin/sh',
      'shift 2 2>/dev/null || true',
      'printf "%s" "$*" > "$DSH_HDC_FAKE_DIR/seen.txt"',
      `printf 'FRAME %s\\n' '${JPEG.length}'`,
      `printf '%s' '${JPEG.toString('base64')}' | base64 -d`,
      '',
    ].join('\n'))
    chmodSync(spyPath, 0o755)

    const result = await recordScreen(spyPath, 'FakePhone123', {
      seconds: 1,
      savePath: path.join(dir, 'clip.mp4'),
      ffmpegPath: undefined,
    })
    assert.ok(result.frames >= 1, 'the stand-in must produce a frame the recorder accepts')

    const seen = await readFile(path.join(dir, 'seen.txt'), 'utf8')
    assert.ok(seen.length > 0, 'the client must have been handed the loop script')
    assert.match(seen, /capture "\$i"\n  emit "\$i"/u, 'a recording must emit strictly in order')
    assert.equal(seen.includes('start()'), false, 'a recording must not pipeline its captures')
  } finally {
    if (previousDir === undefined) delete process.env.DSH_HDC_FAKE_DIR
    else process.env.DSH_HDC_FAKE_DIR = previousDir
    await rm(dir, { recursive: true, force: true })
  }
})

test('a frame-sequence fallback never deletes a directory that was already there', async () => {
  // `<name>-frames` is a path the user may already own, holding anything at all.
  // The fallback used to `rm -rf` it first, which destroyed unrelated files; it
  // must claim a free name instead and leave the existing directory untouched.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-keep-'))
  const previousDir = process.env.DSH_HDC_FAKE_DIR
  const previousFrames = process.env.DSH_HDC_FAKE_FRAMES
  process.env.DSH_HDC_FAKE_DIR = dir
  process.env.DSH_HDC_FAKE_FRAMES = '2'
  try {
    const savePath = path.join(dir, 'clip.mp4')
    const occupied = path.join(dir, 'clip-frames')
    await mkdir(occupied, { recursive: true })
    const marker = path.join(occupied, 'unrelated-user-data.txt')
    await writeFile(marker, 'do not delete me')

    const result = await recordScreen(fakeHdc, 'FakePhone123', {
      seconds: 1,
      savePath,
      ffmpegPath: undefined,
    })

    assert.equal(await readFile(marker, 'utf8'), 'do not delete me', 'the user file must survive')
    assert.equal(result.savedPath, `${occupied}-2`, 'a free numbered name is claimed instead')
    assert.equal((await readdir(result.savedPath)).length, 2, 'every frame still lands somewhere')

    // A second run must not reuse the first fallback directory either.
    const again = await recordScreen(fakeHdc, 'FakePhone123', {
      seconds: 1,
      savePath,
      ffmpegPath: undefined,
    })
    assert.equal(again.savedPath, `${occupied}-3`)
    assert.equal(await readFile(marker, 'utf8'), 'do not delete me')
  } finally {
    if (previousDir === undefined) delete process.env.DSH_HDC_FAKE_DIR
    else process.env.DSH_HDC_FAKE_DIR = previousDir
    if (previousFrames === undefined) delete process.env.DSH_HDC_FAKE_FRAMES
    else process.env.DSH_HDC_FAKE_FRAMES = previousFrames
    await rm(dir, { recursive: true, force: true })
  }
})

test('a recording ends on its deadline even when the device stops producing', async () => {
  // The length is a promise the caller made: `seconds: 1` must not wait for a
  // process that never writes again. The old loop only checked the clock when a
  // frame arrived, so a hung capture held the call open indefinitely.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-stall-'))
  try {
    // A client whose remote loop stays alive and prints nothing at all.
    const stalled = path.join(dir, 'stalled.sh')
    await writeFile(stalled, ['#!/bin/sh', 'sleep 60', ''].join('\n'))
    chmodSync(stalled, 0o755)

    const started = Date.now()
    const options = { seconds: 1, savePath: path.join(dir, 'clip.mp4'), ffmpegPath: undefined }
    // The grace period is part of the contract, so the assertion allows for it
    // while still failing hard on "never returns".
    const watchdog = setTimeout(() => {
      process.stderr.write('the watchdog fired: the deadline did not end the recording\n')
    }, 30_000)
    watchdog.unref?.()
    await assert.rejects(
      () => recordScreen(stalled, 'FakePhone123', options),
      (error) => error.code === 'HDC_RECORD_TIMEOUT' || error.code === 'HDC_CAPTURE_FAILED',
    )
    clearTimeout(watchdog)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 25_000, `a stalled device must end the call, took ${elapsed} ms`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two captures at once do not share a remote scratch directory', async () => {
  // Each loop removes its directory on the way in and again on the way out, so
  // a shared name means the second start deletes the first run's frames and the
  // first finish deletes the second's. A second live stream, or a screenshot
  // taken while a recording runs, is enough to hit it.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-concurrent-'))
  try {
    const spy = path.join(dir, 'spy.sh')
    // Both captures exit without a frame, which is enough: what matters is the
    // script each one was handed, and an early exit cannot interleave two runs'
    // writes to a shared log the way a frame-producing loop could.
    await writeFile(spy, [
      '#!/bin/sh',
      // `-t <serial> shell <script>`: drop all three so `$1` is the script.
      'shift 3 2>/dev/null || true',
      // One file per script, named by a checksum of its own text, so the two
      // concurrent runs cannot overwrite each other's record.
      'sum=$(printf %s "$1" | cksum | cut -d" " -f1)',
      `printf '%s' "$1" > "${dir}/script-$sum.txt"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(spy, 0o755)

    const outcomes = await Promise.allSettled([
      captureFrame(spy, 'FakePhone123'),
      captureFrame(spy, 'FakePhone123'),
    ])
    for (const outcome of outcomes) assert.equal(outcome.status, 'rejected', 'the stand-in produced no frame')

    const names = (await readdir(dir)).filter((name) => name.startsWith('script-'))
    assert.equal(names.length, 2, 'each capture must have run its own script')
    const dirs = []
    for (const name of names) {
      const script = await readFile(path.join(dir, name), 'utf8')
      const chosen = /^d=(\S+)$/mu.exec(script)?.[1]
      assert.ok(chosen !== undefined, 'each script names the directory it works in')
      dirs.push(chosen)
    }
    assert.notEqual(dirs[0], dirs[1], 'concurrent captures must not share one remote directory')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a screenshot stops its capture when the caller cancels', async () => {
  // The route hands the disconnect signal to the capture, and a panel that
  // navigated away must not leave a grab running on the device.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-cancel-shot-'))
  try {
    const stalled = path.join(dir, 'stalled.sh')
    await writeFile(stalled, ['#!/bin/sh', 'sleep 60', ''].join('\n'))
    chmodSync(stalled, 0o755)

    const controller = new AbortController()
    const pending = captureFrame(stalled, 'FakePhone123', { signal: controller.signal, timeoutMs: 60_000 })
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    await assert.rejects(pending, (error) => error.code === 'HDC_RECORD_CANCELLED')
    assert.ok(Date.now() - started < 10_000, 'an abort must end the capture promptly')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a screenshot reports a device that never produces a frame', async () => {
  // A device that accepts the connection and then goes quiet used to hold the
  // capture open for as long as its process lived.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-shot-timeout-'))
  try {
    const stalled = path.join(dir, 'stalled.sh')
    await writeFile(stalled, ['#!/bin/sh', 'sleep 60', ''].join('\n'))
    chmodSync(stalled, 0o755)
    const started = Date.now()
    await assert.rejects(
      () => captureFrame(stalled, 'FakePhone123', { timeoutMs: 300 }),
      (error) => error.code === 'HDC_SCREENSHOT_FAILED',
    )
    assert.ok(Date.now() - started < 10_000, 'the capture deadline must end the wait')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancelling during encoding discards the file instead of finishing it', async () => {
  // Encoding is the slowest step after the capture. Cancelling then used to let
  // ffmpeg run to completion and still leave a video the caller abandoned.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-cancel-enc-'))
  const previousDir = process.env.DSH_HDC_FAKE_DIR
  const previousFrames = process.env.DSH_HDC_FAKE_FRAMES
  process.env.DSH_HDC_FAKE_DIR = dir
  process.env.DSH_HDC_FAKE_FRAMES = '3'
  try {
    const slow = path.join(dir, 'slow-ffmpeg.sh')
    // Ignores its arguments, waits, and writes something that is not a video:
    // what matters is that the process is still running when the cancel lands.
    await writeFile(slow, ['#!/bin/sh', 'sleep 30', 'exit 0', ''].join('\n'))
    chmodSync(slow, 0o755)

    const savePath = path.join(dir, 'clip.mp4')
    const controller = new AbortController()
    const pending = recordScreen(fakeHdc, 'FakePhone123', {
      seconds: 1,
      savePath,
      ffmpegPath: slow,
      signal: controller.signal,
    })
    // Let the capture finish, then cancel while the encoder is running.
    setTimeout(() => controller.abort(), 150)
    const started = Date.now()
    await assert.rejects(pending, (error) => error.code === 'HDC_RECORD_CANCELLED')
    assert.ok(Date.now() - started < 20_000, 'a cancel during encoding must end the call')
    await assert.rejects(() => readFile(savePath), 'no video may be left behind')
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.mp4') || name.includes('clip-frames'))
    assert.deepEqual(leftovers, [], `a cancel must leave no artifact, found ${leftovers.join(', ')}`)
  } finally {
    if (previousDir === undefined) delete process.env.DSH_HDC_FAKE_DIR
    else process.env.DSH_HDC_FAKE_DIR = previousDir
    if (previousFrames === undefined) delete process.env.DSH_HDC_FAKE_FRAMES
    else process.env.DSH_HDC_FAKE_FRAMES = previousFrames
    await rm(dir, { recursive: true, force: true })
  }
})

test('a capture size must be given as a pair, never half of one', () => {
  // `snapshot_display` takes `-w`/`-h` as one size. Ignoring a lone side meant a
  // documented option that did nothing: the caller asked for 480 px wide and got
  // a full-resolution capture with no indication why.
  for (const options of [{ width: 480 }, { height: 1060 }]) {
    assert.throws(
      () => frameLoopScript({ maxFrames: 2, ...options }),
      (error) => error.code === 'HDC_BAD_ARGS',
      `${JSON.stringify(options)} must be refused`,
    )
  }
  // The pair is honoured, and neither side keeps the size flags absent.
  assert.match(frameLoopScript({ maxFrames: 2, width: 480, height: 1060 }), /-w 480 -h 1060/u)
  assert.equal(frameLoopScript({ maxFrames: 2 }).includes('-w '), false)
})

test('a recording that fails on the filesystem leaves no temp frames behind', async () => {
  // A full disk, a target whose parent is not a directory, or a frame that cannot
  // be copied all used to leave the captured sequence in the system temp
  // directory: the cleanup lived in the success and cancel branches only.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-tempfix-'))
  const previousDir = process.env.DSH_HDC_FAKE_DIR
  const previousFrames = process.env.DSH_HDC_FAKE_FRAMES
  process.env.DSH_HDC_FAKE_DIR = dir
  process.env.DSH_HDC_FAKE_FRAMES = '3'
  const before = new Set(await readdir(tmpdir()))
  try {
    // A file where the save path's parent should be: `mkdir` fails after the
    // frames have already been written.
    const blocker = path.join(dir, 'not-a-dir')
    await writeFile(blocker, 'x')
    await assert.rejects(
      () => recordScreen(fakeHdc, 'FakePhone123', {
        seconds: 1,
        savePath: path.join(blocker, 'clip.mp4'),
        ffmpegPath: undefined,
      }),
    )
    const created = (await readdir(tmpdir())).filter((name) => name.startsWith('dsh-hdc-rec-') && !before.has(name))
    assert.deepEqual(created, [], `a failed recording must not leave temp frames, found ${created.join(', ')}`)
    // The blocker is untouched: the failure must not have removed the user's file.
    assert.equal(await readFile(blocker, 'utf8'), 'x')
  } finally {
    if (previousDir === undefined) delete process.env.DSH_HDC_FAKE_DIR
    else process.env.DSH_HDC_FAKE_DIR = previousDir
    if (previousFrames === undefined) delete process.env.DSH_HDC_FAKE_FRAMES
    else process.env.DSH_HDC_FAKE_FRAMES = previousFrames
    await rm(dir, { recursive: true, force: true })
  }
})
