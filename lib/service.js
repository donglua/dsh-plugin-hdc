/**
 * The device operations, decoupled from any one caller.
 *
 * The `hdc_*` tools and the `/hdc` HTTP routes both need the same operations.
 * Keeping them here — instead of inside the tool definitions or inside the route
 * handler — is what stops the two surfaces from drifting into different command
 * lines, different failure wording, or different defaults.
 *
 * Nothing here knows about the model-facing shape of a result or about HTTP;
 * callers add that.
 *
 * @module hdc-tools/service
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { remember } from './artifacts.js'
import { captureFrame, discoverFfmpeg, frameDirFor, imageSize, openFrameStream, recordScreen } from './frames.js'
import { discoverHdc } from './hdc.js'
import {
  buildInputCommand,
  captureScreen,
  dumpInterface,
  listSerials,
  readLogs,
  requireDevice,
  requireHdc,
  runInputCommand,
} from './tools.js'

/**
 * Resolve the client from config.
 *
 * The search runs on every call rather than once at load: a user who installs
 * DevEco Studio, or fixes `hdcPath`, gets a working route without restarting
 * the host. `requireHdc` then refuses with an actionable message naming the
 * setting to fix, which is the whole point — without a client nothing can be
 * tried, so the caller should not have to guess between "not installed" and
 * "installed elsewhere".
 */
async function clientOf(config) {
  return requireHdc({ hdcPath: await discoverHdc(config?.hdcPath) })
}

/** A recording length that is always a whole number of seconds in range. */
function clampSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 10
  return Math.min(180, Math.max(1, Math.trunc(value)))
}

/** A capture dimension that is a usable pixel count, or nothing at all. */
function positiveOrUndefined(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const whole = Math.trunc(value)
  return whole > 0 ? whole : undefined
}

/** Where a panel capture or recording is written: the configured download directory. */
function downloadDirOf(config) {
  return config?.downloadDir ?? process.cwd()
}

/**
 * A unique file name for a capture, so two of them never collide.
 *
 * A timestamp alone is not enough: two panel actions can finish inside the same
 * millisecond, and then both write the same path and one silently replaces the
 * other. The random suffix is what makes the name unique rather than merely
 * specific to the moment.
 */
function stamp(prefix, extension) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${now.getMilliseconds()}`
    + `-${randomUUID().slice(0, 8)}`
    + `.${extension}`
}

/** List attached connect keys. */
export async function listDevices(config, signal) {
  const hdcPath = await clientOf(config)
  // The panel's device list and its refresh button both land here, and both mean
  // "what is attached right now", so this always asks the device.
  return { hdcPath, devices: await listSerials(hdcPath, { signal, fresh: true }) }
}

/**
 * Capture the screen as image bytes.
 *
 * The media type comes from the sniffed file signature rather than a fixed
 * `image/png`, because the routes put it straight into a response header and a
 * wrong type makes the browser refuse to render what it was sent.
 */
export async function screenshot(config, device, signal) {
  const hdcPath = await clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  const captured = await captureScreen(hdcPath, serial, signal)
  return { device: serial, data: captured.data, mediaType: captured.mediaType }
}

/**
 * Send one touch, gesture, text, or key event.
 *
 * The command is built before the device round-trip for the same reason the
 * tool does it: a missing coordinate is the caller's mistake and should not
 * cost a device call first.
 */
export async function input(config, device, args, signal) {
  const command = buildInputCommand(args ?? {})
  const hdcPath = await clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  const output = await runInputCommand(hdcPath, serial, command, args.action, signal)
  return { device: serial, command, ...output === undefined ? {} : { output } }
}

/**
 * Dump the interface hierarchy.
 *
 * Answers both views of the one dump: the flat text a model reads, and the
 * outline a panel draws. They are produced together because they come from the
 * same device round-trip, which costs about a second.
 */
export async function uiTree(config, device, allNodes, signal) {
  const hdcPath = await clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  const dumped = await dumpInterface(hdcPath, serial, allNodes === true, signal)
  return { device: serial, ...dumped }
}

/** Read the recent log tail, filtered by keyword and/or crash markers. */
export async function logs(config, device, opts, signal) {
  const hdcPath = await clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  const read = await readLogs(hdcPath, serial, opts ?? {}, signal)
  return { device: serial, ...read }
}

/**
 * Open a live frame stream for the panel's picture.
 *
 * The caller owns the returned stream and must call `stop()` on it. Everything
 * that can fail here has failed by the time this resolves — an absent client, an
 * absent device — so the route can answer with a proper status before it starts
 * writing `multipart/x-mixed-replace` headers, which cannot be taken back.
 *
 * @param options.device - connect key, or undefined for the only device.
 * @param options.width - scaled capture width; omitted means device resolution.
 * @param options.height - scaled capture height.
 * @param options.intervalMs - pause between frames.
 * @returns the resolved device and an open frame stream.
 */
export async function openStream(config, options, signal) {
  const hdcPath = await clientOf(config)
  const serial = await requireDevice(hdcPath, options?.device, { signal })
  const stream = openFrameStream(hdcPath, serial, {
    dir: frameDirFor('live'),
    width: options?.width,
    height: options?.height,
    intervalMs: options?.intervalMs,
  })
  return { device: serial, stream }
}

/**
 * Capture one still at device resolution and keep it as a downloadable file.
 *
 * This backs the panel's 截图 button. It is deliberately not the same call as
 * `screenshot()`: that one answers image bytes for an `<img>`, while this one
 * leaves a file the user asked to keep, and reports where.
 *
 * @returns the artifact id, its local path, and the image's size.
 */
export async function captureStill(config, device, signal) {
  const hdcPath = await clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  // The route's disconnect signal reaches the actual capture: a panel that
  // navigated away must not leave a grab running on the device.
  const captured = await captureFrame(hdcPath, serial, { signal })
  const dir = downloadDirOf(config)
  await mkdir(dir, { recursive: true })
  const extension = captured.mediaType === 'image/png' ? 'png' : 'jpg'
  const filePath = path.join(dir, stamp('hdc-shot', extension))
  await writeFile(filePath, captured.data)
  const size = imageSize(captured.data)
  const artifactId = remember({
    path: filePath,
    mediaType: captured.mediaType,
    name: path.basename(filePath),
    kind: 'screenshot',
  })
  return {
    device: serial,
    artifactId,
    savedPath: filePath,
    bytes: captured.data.byteLength,
    ...size === undefined ? {} : { size },
  }
}

/**
 * Record the screen for a bounded number of seconds and keep the result.
 *
 * HarmonyOS builds without `screenrecord` still produce a recording here: frames
 * are pulled at whatever rate the device can manage and joined into an mp4 by
 * ffmpeg. When ffmpeg is missing or refuses, the frames themselves are kept
 * under a `-frames` directory rather than the whole call failing.
 */
export async function record(config, device, options, signal) {
  const hdcPath = await clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  // `Math.trunc(NaN)` is `NaN`, and a script built from it asks the device for
  // `-lt NaN` frames, which never matches. The number is validated at the edge,
  // but this is the last place before it becomes device text.
  const seconds = clampSeconds(options?.seconds)
  const dir = downloadDirOf(config)
  await mkdir(dir, { recursive: true })
  const ffmpegPath = discoverFfmpeg(config?.ffmpegPath)
  const result = await recordScreen(hdcPath, serial, {
    seconds,
    savePath: path.join(dir, stamp('hdc-rec', 'mp4')),
    ffmpegPath,
    width: positiveOrUndefined(options?.width),
    height: positiveOrUndefined(options?.height),
    signal,
  })
  const artifactId = remember({
    path: result.savedPath,
    mediaType: result.kind === 'video' ? 'video/mp4' : 'application/octet-stream',
    name: path.basename(result.savedPath),
    kind: result.kind,
  })
  return {
    device: serial,
    artifactId,
    kind: result.kind,
    savedPath: result.savedPath,
    frames: result.frames,
    seconds: result.seconds,
    bytes: result.bytes,
    ...result.size === undefined ? {} : { size: result.size },
    ...result.note === undefined ? {} : { note: result.note },
  }
}
