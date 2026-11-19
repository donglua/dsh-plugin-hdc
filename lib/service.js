/**
 * The device operations, decoupled from any one caller.
 *
 * The `hdc_*` tools and the `/hdc` HTTP routes both need the same five
 * operations. Keeping them here — instead of inside the tool definitions or
 * inside the route handler — is what stops the two surfaces from drifting into
 * different command lines, different failure wording, or different defaults.
 *
 * Nothing here knows about the model-facing shape of a result or about HTTP;
 * callers add that.
 *
 * @module hdc-tools/service
 */

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
function clientOf(config) {
  return requireHdc({ hdcPath: discoverHdc(config?.hdcPath) })
}

/** List attached connect keys. */
export async function listDevices(config, signal) {
  const hdcPath = clientOf(config)
  return { hdcPath, devices: await listSerials(hdcPath, { signal }) }
}

/**
 * Capture the screen as image bytes.
 *
 * The media type comes from the sniffed file signature rather than a fixed
 * `image/png`, because the routes put it straight into a response header and a
 * wrong type makes the browser refuse to render what it was sent.
 */
export async function screenshot(config, device, signal) {
  const hdcPath = clientOf(config)
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
  const hdcPath = clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  const output = await runInputCommand(hdcPath, serial, command, args.action, signal)
  return { device: serial, command, ...output === undefined ? {} : { output } }
}

/** Dump the interface hierarchy, rendered for a caller. */
export async function uiTree(config, device, allNodes, signal) {
  const hdcPath = clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  const dumped = await dumpInterface(hdcPath, serial, allNodes === true, signal)
  return { device: serial, ...dumped }
}

/** Read the recent log tail, filtered by keyword and/or crash markers. */
export async function logs(config, device, opts, signal) {
  const hdcPath = clientOf(config)
  const serial = await requireDevice(hdcPath, device, { signal })
  const read = await readLogs(hdcPath, serial, opts ?? {}, signal)
  return { device: serial, ...read }
}
