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

/** DevEco Studio installs the toolchain under these roots, newest layout first. */
const DEVECO_ROOTS = [
  '/Applications/DevEco-Studio.app/Contents/sdk',
  '/Applications/DevEco-Studio.app/Contents/sdk/default',
]

/** Toolchain locations relative to one DevEco `sdk` root. */
const TOOLCHAIN_LAYOUTS = [
  'default/openharmony/toolchains/hdc',
  'openharmony/toolchains/hdc',
  'HarmonyOS-NEXT-DB1/openharmony/toolchains/hdc',
]

/** Standalone HarmonyOS SDK roots, plus the Windows command suffix. */
const SDK_HOME_LAYOUTS = [
  'openharmony/toolchains/hdc',
  'HarmonyOS-NEXT-DB1/openharmony/toolchains/hdc',
  'hmscore/toolchains/hdc',
]

/** Resolve the first existing candidate path, or `undefined`. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

/** Every `hdc` reachable on PATH, in PATH order. */
function fromPath(env = process.env) {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['hdc.exe', 'hdc'] : ['hdc']
  const found = []
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Locate the `hdc` client.
 *
 * An explicit path from configuration always wins. Otherwise the DevEco
 * toolchain is searched before PATH, because a stray or stale `hdc` on PATH is
 * the usual cause of "device not found" when DevEco itself connects fine.
 *
 * @param configured - `hdcPath` from plugin config, when set.
 * @returns the absolute client path, or `undefined` when nothing was found.
 */
export function discoverHdc(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const expanded = configured.trim().replace(/^~(?=\/)/, os.homedir())
    if (existsSync(expanded)) return expanded
  }
  const deveco = []
  for (const root of DEVECO_ROOTS) {
    for (const layout of TOOLCHAIN_LAYOUTS) deveco.push(path.join(root, layout))
  }
  const sdkHomes = [
    process.env.HOS_SDK_HOME,
    process.env.HARMONYOS_SDK_HOME,
    process.env.DEVECO_SDK_HOME,
    path.join(os.homedir(), 'Library', 'Huawei', 'Sdk'),
    path.join(os.homedir(), 'AppData', 'Local', 'Huawei', 'Sdk'),
    '/opt/harmonyos-sdk',
  ].filter(Boolean)
  const sdkCandidates = []
  for (const home of sdkHomes) {
    for (const layout of SDK_HOME_LAYOUTS) sdkCandidates.push(path.join(home, layout))
  }
  return firstExisting([...deveco, ...sdkCandidates, ...fromPath()])
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
