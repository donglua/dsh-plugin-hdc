/**
 * Locating and running the HarmonyOS `hdc` client.
 *
 * Everything here is self-contained: no host package is imported, so the
 * bundle installs from a plain directory with no build step.
 *
 * @module hdc-tools/hdc
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { isIP, isIPv6 } from 'node:net'

/**
 * The `hdc` client relative to one SDK root, newest layout first.
 *
 * A DevEco Studio install and a standalone HarmonyOS SDK differ only in where
 * that root sits, not in what is under it, so both go through this one list.
 * `default/` is the layout every current DevEco and command-line-tools release
 * ships; the unqualified forms cover older SDKs and the `HarmonyOS-NEXT-DB1`
 * beta layout. `hmscore/toolchains` is the HMS variant of the same idea.
 */
const TOOLCHAIN_LAYOUTS = [
  'default/openharmony/toolchains/hdc',
  'openharmony/toolchains/hdc',
  'HarmonyOS-NEXT-DB1/openharmony/toolchains/hdc',
  'default/hms/toolchains/hdc',
  'hmscore/toolchains/hdc',
]

/** Environment variables that name an SDK root, most specific first. */
const SDK_HOME_VARS = [
  'DEVECO_SDK_HOME',
  'HOS_SDK_HOME',
  'HARMONYOS_SDK_HOME',
  'OHOS_SDK_HOME',
  'OHOS_BASE_SDK_HOME',
  'HOS_SDK_PATH',
]

/** Environment variables that name a DevEco Studio (or tools) install root. */
const TOOL_HOME_VARS = ['DEVECO_HOME', 'DEVECO_STUDIO_HOME', 'TOOL_HOME', 'HOS_TOOLCHAIN_HOME']

/** Resolve the first existing candidate path, or `undefined`. */
function firstExisting(candidates, existing = existsSync) {
  for (const candidate of candidates) {
    if (candidate && existing(candidate)) return candidate
  }
  return undefined
}

/** The client file names to try, in preference order, on one platform. */
function clientNames(platform = process.platform) {
  return platform === 'win32' ? ['hdc.exe', 'hdc'] : ['hdc']
}

/** One file name in a toolchain layout, without assuming a POSIX `hdc` suffix. */
function named(layout, name) {
  return name === 'hdc' ? layout : layout.replace(/hdc$/u, name)
}

/**
 * Every `hdc` path the given roots could hold, in root then layout order.
 *
 * The bare root is tried too, so a variable pointing straight at a `toolchains`
 * directory — a shape users do produce by copying the path off the binary —
 * resolves instead of being silently skipped.
 */
function clientsUnder(roots, platform = process.platform) {
  const names = clientNames(platform)
  const candidates = []
  for (const root of roots) {
    for (const layout of TOOLCHAIN_LAYOUTS) {
      for (const name of names) candidates.push(path.join(root, named(layout, name)))
    }
    for (const name of names) candidates.push(path.join(root, name))
  }
  return candidates
}

/** Every `hdc` reachable on PATH, in PATH order. */
function fromPath(env = process.env, platform = process.platform, existing = existsSync) {
  const names = clientNames(platform)
  const found = []
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existing(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * SDK roots named by the environment.
 *
 * The value may point at the SDK itself (`DEVECO_SDK_HOME` is documented as
 * `<tool-home>/sdk`) or at the directory holding it (`TOOL_HOME`), and a macOS
 * bundle sits one level further down, so each value yields the shapes both
 * conventions produce. Duplicates are dropped so the same root is not probed
 * twice.
 */
function rootsFromEnv(env = process.env, home = os.homedir()) {
  const values = []
  for (const name of [...SDK_HOME_VARS, ...TOOL_HOME_VARS]) {
    const raw = env[name]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    values.push(raw.trim().replace(/^~(?=\/)/, home))
  }
  const roots = []
  for (const value of values) {
    roots.push(value, path.join(value, 'sdk'), path.join(value, 'Contents', 'sdk'), path.join(value, 'Contents'))
  }
  return [...new Set(roots)]
}

/**
 * SDK roots implied by the `PATH`.
 *
 * A DevEco Studio installed somewhere other than `/Applications` — a home
 * directory, a second volume — still has its `tools/hvigor/bin` on PATH, and a
 * command-line-tools checkout adds `<tools>/bin`. Walking up from each PATH
 * entry finds the install root without the plugin knowing where it lives.
 *
 * @returns candidate SDK roots, nearest-parent first.
 */
function rootsFromPath(env = process.env) {
  // `<root>/Contents/sdk/default/openharmony/toolchains` is four levels below
  // the bundle and two below the SDK root.
  const DEPTH = 5
  const roots = []
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    let current = path.resolve(dir)
    for (let level = 0; level < DEPTH; level += 1) {
      roots.push(current, path.join(current, 'sdk'), path.join(current, 'Contents', 'sdk'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return [...new Set(roots)]
}

/** Where an SDK lives when no environment variable and no PATH entry says. */
function platformSdkRoots(home = os.homedir(), platform = process.platform) {
  if (platform === 'win32') {
    return [
      path.join(home, 'AppData', 'Local', 'Huawei', 'Sdk'),
      path.join(home, 'AppData', 'Local', 'Huawei', 'sdk'),
      'C:\\Program Files\\Huawei\\DevEco Studio\\sdk',
    ]
  }
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Huawei', 'Sdk'),
      path.join(home, 'Library', 'Huawei', 'sdk'),
      '/Applications/DevEco-Studio.app/Contents/sdk',
      '/opt/harmonyos-sdk',
    ]
  }
  return [path.join(home, 'Huawei', 'Sdk'), '/opt/harmonyos-sdk']
}

/** How long a login-shell answer is reused before it is read again. */
const LOGIN_SHELL_CACHE_MS = 5 * 60_000

/** A login shell that has not answered by then is not worth waiting for. */
const LOGIN_SHELL_TIMEOUT_MS = 2000

/** Last login-shell answer, so the common path costs one spawn per few minutes. */
let loginShellCache

/**
 * The login-shell probe currently running, shared by every caller that asks while
 * it is in flight.
 *
 * Caching the promise rather than the answer is what keeps a burst of device calls
 * from each starting an interactive shell: `clientOf` runs on every request, and
 * an uncached probe would spawn one shell per concurrent request for as long as
 * the first one takes.
 */
let loginShellInFlight

/**
 * Forget the cached login-shell answer.
 *
 * The cache is process-wide and correct for a running Host, where the answer
 * changes when the user edits their shell profile. A test that fakes a shell has
 * to start from no answer, so this is the one seam it needs.
 */
export function forgetLoginShellCache() {
  loginShellCache = undefined
  loginShellInFlight = undefined
}

/**
 * Read the SDK roots the user's login shell exports.
 *
 * `execFile` rather than `execFileSync`: this runs on the request path whenever
 * the earlier search stages come up empty, and a synchronous probe stops the whole
 * Host — every other request and tool call — for as long as an interactive shell
 * takes to start. The answer is cached, and the in-flight promise is shared, so
 * the cost is one shell per five minutes rather than one per call.
 *
 * @returns a promise for the candidate roots.
 */
async function rootsFromLoginShell(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return []
  const now = Date.now()
  if (loginShellCache !== undefined && now - loginShellCache.at < LOGIN_SHELL_CACHE_MS) {
    return loginShellCache.roots
  }
  if (loginShellInFlight !== undefined) return loginShellInFlight
  loginShellInFlight = probeLoginShell(env, home).then((roots) => {
    loginShellCache = { at: Date.now(), roots }
    loginShellInFlight = undefined
    return roots
  })
  return loginShellInFlight
}

/**
 * Spawn the login shell once and parse the variables it printed.
 * @returns a promise for the candidate roots, empty when it gave no answer.
 */
function probeLoginShell(env, home) {
  const shell = typeof env.SHELL === 'string' && path.isAbsolute(env.SHELL) ? env.SHELL : undefined
  if (shell === undefined) return Promise.resolve([])
  const base = path.basename(shell)
  if (!['bash', 'zsh', 'fish'].includes(base)) return Promise.resolve([])
  const names = [...SDK_HOME_VARS, ...TOOL_HOME_VARS]
  const script = names.map((name) => `printf '%s\\n' "\${${name}-}"`).join(';')
  const argv = base === 'fish' ? ['--login', '--interactive', '--command', script] : ['-ilc', script]
  return new Promise((resolve) => {
    execFile(shell, argv, {
      encoding: 'utf8',
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      // A shell that fails, hangs, or prints nothing is simply no answer; the
      // remaining heuristics still get a chance.
      if (error || typeof stdout !== 'string') {
        resolve([])
        return
      }
      // One line per variable, in the order they were printed, so an unset one is
      // an empty line and does not shift the rest out of position.
      const values = stdout.split('\n')
      const env2 = {}
      for (const [index, name] of names.entries()) env2[name] = values[index] ?? ''
      resolve(rootsFromEnv(env2, home))
    })
  })
}

/**
 * Locate the `hdc` client.
 *
 * An explicit `hdcPath` wins outright. Then the environment, because a user who
 * exports `DEVECO_SDK_HOME` has already said where the SDK is. Then the
 * conventional install locations, which are the common case and the answer a
 * DevEco Studio user expects. Then the SDK roots implied by PATH, so an install
 * outside those locations is still found. Last, PATH itself: a stray `hdc`
 * there is a common cause of "device not found" when DevEco itself connects
 * fine, which is why it is the last resort rather than the first.
 *
 * @param configured - `hdcPath` from plugin config, when set.
 * @param options.env - environment to read; defaults to `process.env`.
 * @param options.platform - platform whose path shapes apply.
 * @param options.home - home directory; defaults to `os.homedir()`.
 * @param options.existing - path probe, injectable for tests.
 * @param options.loginShell - set false to skip the login-shell recovery.
 * @returns the absolute client path, or `undefined` when nothing was found.
 */
let lastDiscoveredHdc

/** Forget the cached `discoverHdc` result. */
export function forgetHdcCache() {
  lastDiscoveredHdc = undefined
}

export async function discoverHdc(configured, options = {}) {
  const canCache = options.env === undefined
    && options.platform === undefined
    && options.home === undefined
    && options.existing === undefined
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? os.homedir()
  const existing = options.existing ?? existsSync

  if (canCache && lastDiscoveredHdc !== undefined && lastDiscoveredHdc.configured === configured && existing(lastDiscoveredHdc.path)) {
    return lastDiscoveredHdc.path
  }

  const remember = (hit) => {
    if (canCache && hit !== undefined) lastDiscoveredHdc = { configured, path: hit }
    return hit
  }

  if (typeof configured === 'string' && configured.trim() !== '') {
    const expanded = configured.trim().replace(/^~(?=\/)/, home)
    if (existing(expanded)) return remember(expanded)
  }

  const stages = [rootsFromEnv(env, home), platformSdkRoots(home, platform), rootsFromPath(env)]
  for (const roots of stages) {
    const hit = firstExisting(clientsUnder(roots, platform), existing)
    if (hit !== undefined) return remember(hit)
  }

  // Last before PATH, because it costs a subprocess: a packaged desktop app
  // does not inherit a terminal's exports, so this is what recovers a working
  // `DEVECO_SDK_HOME` for a user whose only install is a command-line-tools
  // checkout outside every conventional location.
  if (options.loginShell !== false) {
    const shellRoots = await rootsFromLoginShell(env, platform, home)
    const shellHit = firstExisting(clientsUnder(shellRoots, platform), existing)
    if (shellHit !== undefined) return remember(shellHit)
  }

  return remember(firstExisting(fromPath(env, platform, existing), existing))
}

/** Render one argument for a POSIX remote shell. */
export function shq(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * Run one `hdc` invocation.
 *
 * A missing device makes `hdc` print `[Fail]...` on stdout while still exiting
 * 0, so the marker is checked alongside the exit code.
 *
 * @returns the outcome; `ok` is false for a nonzero exit, a `[Fail]` marker, or a timeout.
 */
export function runHdc(hdcPath, serial, argv, options = {}) {
  const { timeoutMs = 60_000, signal, maxBuffer = 16 * 1024 * 1024 } = options
  const full = serial ? ['-t', serial, ...argv] : argv
  return new Promise((resolve) => {
    execFile(
      hdcPath,
      full,
      { timeout: timeoutMs, signal, maxBuffer, encoding: 'utf8', killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        const failed = /^\s*\[Fail\]/mu.test(out) || /^\s*\[Fail\]/mu.test(err)
        const timedOut = Boolean(error && (error.killed === true || error.code === 'ETIMEDOUT'))
        resolve({
          ok: !error && !failed,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          timedOut,
          stdout: out,
          stderr: err,
          message: failed ? firstFailureLine(out, err) : error ? String(error.message ?? error) : undefined,
        })
      },
    )
  })
}

/** The `[Fail]` line from either stream, for a short error message. */
function firstFailureLine(stdout, stderr) {
  for (const stream of [stdout, stderr]) {
    for (const line of stream.split('\n')) {
      if (/^\s*\[Fail\]/u.test(line)) return line.trim()
    }
  }
  return undefined
}

/** The conventional HarmonyOS wireless-debugging port. */
export const DEFAULT_REMOTE_PORT = 8710

/** Reject a configured endpoint before it can change hdc's connection state. */
function invalidRemoteAddress() {
  const error = new Error('remoteAddress must be host, host:port, [IPv6], or [IPv6]:port')
  error.code = 'HDC_BAD_ARGS'
  return error
}

/** Whether a non-IP value is one DNS hostname, including a single label. */
function isHostname(value) {
  if (value.length === 0 || value.length > 253) return false
  return value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
}

/**
 * Validate `remoteAddress` and return the canonical argument for `hdc tconn`.
 *
 * The port defaults to 8710. An IPv6 literal needs brackets only when a port is
 * present, because an unbracketed colon is already part of the address itself.
 * The result is passed to `execFile` as one argument, never to a shell.
 */
export function normalizeRemoteAddress(value) {
  if (typeof value !== 'string' || value.trim() === '') throw invalidRemoteAddress()
  const input = value.trim()
  let host = input
  let port = DEFAULT_REMOTE_PORT

  if (input.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/u.exec(input)
    if (match === null || !isIPv6(match[1])) throw invalidRemoteAddress()
    host = match[1]
    if (match[2] !== undefined) port = Number(match[2])
  } else if (!isIPv6(input)) {
    const separator = input.lastIndexOf(':')
    if (separator >= 0) {
      host = input.slice(0, separator)
      const portText = input.slice(separator + 1)
      if (!/^\d+$/u.test(portText)) throw invalidRemoteAddress()
      port = Number(portText)
    }
  }

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw invalidRemoteAddress()
  const ipVersion = isIP(host)
  if (ipVersion === 0 && !isHostname(host)) throw invalidRemoteAddress()
  return `${ipVersion === 6 ? `[${host}]` : host}:${port}`
}

/**
 * Parse `hdc list targets` output into connect keys.
 * @param stdout - raw output, which contains `[Empty]` for no devices.
 */
export function parseTargets(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== '[Empty]' && !line.startsWith('['))
}

/**
 * Decide which device one call targets.
 *
 * @param serials - connect keys currently attached.
 * @param requested - the call's optional `device` argument.
 * @returns the connect key, or an error message naming what to do instead.
 */
export function selectDevice(serials, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    const wanted = requested.trim()
    // Accept a unique prefix so a long TCP key need not be retyped in full.
    const matches = serials.filter((serial) => serial === wanted)
    if (matches.length === 1) return { serial: matches[0] }
    const prefixed = serials.filter((serial) => serial.startsWith(wanted))
    if (prefixed.length === 1) return { serial: prefixed[0] }
    if (serials.length === 0) return { error: 'no HarmonyOS device is connected; connect a device or start an emulator, then retry' }
    // A prefix shared by several devices is ambiguous, not absent: say so, so
    // the caller lengthens the key instead of concluding nothing is attached.
    if (prefixed.length > 1) {
      return { error: `"${wanted}" matches several attached devices; pass a longer key, one of: ${prefixed.join(', ')}` }
    }
    return { error: `no attached device matches "${wanted}"; attached: ${serials.join(', ')}` }
  }
  if (serials.length === 0) return { error: 'no HarmonyOS device is connected; connect a device or start an emulator, then retry' }
  if (serials.length === 1) return { serial: serials[0] }
  return { error: `several devices are attached; pass device with one of: ${serials.join(', ')}` }
}

/**
 * Decode the media type declared by an image file signature.
 * @returns the media type, or `undefined` when the bytes are not a supported image.
 */
export function sniffImageMediaType(data) {
  const at = (offset, bytes) => bytes.every((byte, index) => data[offset + index] === byte)
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      if (data[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/** Keep a tool result bounded, naming how much was dropped. */
export function clip(text, maxChars = 20_000) {
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  const dropped = text.length - maxChars
  return `${text.slice(0, half)}\n\n... [${dropped} characters omitted] ...\n\n${text.slice(-half)}`
}

/** Run one remote shell command through `hdc shell`. */
export function shell(hdcPath, serial, command, options) {
  return runHdc(hdcPath, serial, ['shell', command], options)
}
