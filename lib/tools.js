/**
 * The `hdc_*` tool family.
 *
 * Each tool resolves the client and the target device itself, so the model can
 * call any of them without a preceding setup step. The screenshot tool is the
 * only one that returns an image block, through the same attachment service the
 * deployment already uses for `read_image`.
 *
 * Tools are registered as raw definitions rather than through `defineTool`, so
 * the bundle stays self-contained and installs from a plain directory with no
 * build step and no dependency on a host package.
 *
 * @module hdc-tools/tools
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverFfmpeg, recordScreen } from './frames.js'
import {
  clip,
  discoverHdc,
  parseTargets,
  runHdc,
  selectDevice,
  shell,
  shq,
  sniffImageMediaType,
} from './hdc.js'

/** Remote scratch directory, writable without root on a normal device. */
const REMOTE_TMP = '/data/local/tmp'

/** Raise one tool error with a stable code. */
function toolError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Failure text for one `hdc` outcome, preferring its `[Fail]` line. */
function failureText(outcome) {
  if (outcome.timedOut) return 'the hdc command timed out'
  const detail = outcome.message ?? (outcome.stderr.trim() || outcome.stdout.trim())
  return detail === '' || detail === undefined ? `hdc exited with code ${outcome.exitCode}` : detail
}

/** Throw a tool error carrying the device-side failure text. */
function ensureOk(outcome, what) {
  if (outcome.ok) return
  throw toolError(`${what} failed: ${failureText(outcome)}`, 'HDC_COMMAND_FAILED')
}

/** Resolve the client and the session directory for downloaded files. */
function runtime(config, exec) {
  return {
    hdcPath: discoverHdc(config.hdcPath),
    workdir: config.downloadDir ?? exec.agent?.session?.header?.cwd ?? process.cwd(),
  }
}

/** Resolve the client or refuse with an actionable message. */
function requireHdc(rt) {
  if (rt.hdcPath === undefined) {
    throw toolError(
      'hdc was not found. Install DevEco Studio or the HarmonyOS command-line tools, '
      + 'check that DEVECO_SDK_HOME points at the sdk directory of that install, '
      + 'or set hdcPath in the hdc-tools plugin settings to the full path of the hdc executable.',
      'HDC_NOT_FOUND',
    )
  }
  return rt.hdcPath
}

/**
 * How long a `list targets` answer is reused.
 *
 * Every device call resolves its target first, so a tap costs two `hdc`
 * spawns — one to list, one to act — and the list is nearly always the same
 * answer within the moment it takes a finger to tap twice. Reusing it briefly
 * halves the process spawns behind a tap, which is the panel's hot path.
 *
 * Kept short on purpose: a device plugged in or unplugged must still show up
 * almost immediately. The explicit listing calls (`hdc_devices` and the panel's
 * device refresh) bypass this entirely, so "what is attached right now" is
 * always a fresh answer.
 */
const TARGETS_TTL_MS = 1200

/** Last `list targets` answer per client path, reusable for `TARGETS_TTL_MS`. */
const targetsCache = new Map()

/** Drop the cached attachment list, so the next resolution asks the device. */
export function invalidateTargets() {
  targetsCache.clear()
}

/** List attached connect keys, reusing an answer younger than the TTL. */
async function listSerials(hdcPath, options = {}) {
  if (options.fresh !== true) {
    const cached = targetsCache.get(hdcPath)
    if (cached !== undefined && Date.now() - cached.at < TARGETS_TTL_MS) return cached.serials
  }
  const outcome = await runHdc(hdcPath, undefined, ['list', 'targets'], options)
  ensureOk(outcome, 'listing devices')
  const serials = parseTargets(outcome.stdout)
  // Only a non-empty answer is worth reusing. An empty one costs nothing to
  // repeat — the call fails either way — and caching it would hide a device the
  // user plugged in a moment later, which is exactly when they are waiting for
  // the tap to work.
  if (serials.length > 0 && options.signal?.aborted !== true) {
    targetsCache.set(hdcPath, { at: Date.now(), serials })
  }
  return serials
}

/** Resolve the device for this call, or refuse naming the attachments. */
async function requireDevice(hdcPath, requested, options) {
  const chosen = selectDevice(await listSerials(hdcPath, options), requested)
  if (chosen.error !== undefined) throw toolError(chosen.error, 'HDC_DEVICE_UNAVAILABLE')
  return chosen.serial
}

/** Prepare a private local scratch directory, removed by the caller. */
async function scratchDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix))
}

/** Pull a remote file into a local path. */
async function pullTo(hdcPath, serial, remote, localPath, options) {
  ensureOk(await runHdc(hdcPath, serial, ['file', 'recv', remote, localPath], options), `receiving ${remote}`)
  return localPath
}

/**
 * Capture the screen and return its bytes.
 *
 * Two commands are attempted because which one exists varies across OpenHarmony
 * and HarmonyOS NEXT versions. Their output naming differs in a way that the
 * remote file name must respect:
 *
 * - `snapshot_display` **validates the suffix** and refuses anything but
 *   `.jpeg` (`error: fileName … invalid, suffix must be .jpeg`), then writes
 *   JPEG regardless of what was asked for. It is also the fast path: an 8x8
 *   capture still costs ~360 ms, because the cost is the RenderService
 *   round-trip and not the pixels or the encoder.
 * - `uitest screenCap` ignores the suffix and always writes PNG, which it does
 *   roughly 50% slower than `snapshot_display` and at a much larger size.
 *
 * So each command gets a name with the suffix it accepts, and the real type is
 * sniffed from the bytes rather than assumed from either name.
 */
async function captureScreen(hdcPath, serial, signal) {
  const stamp = `${Date.now()}`
  // One remote name per command, each spelled the way that command accepts.
  const attempts = [
    { command: (remote) => `snapshot_display -f ${shq(remote)}`, ext: 'jpeg' },
    { command: (remote) => `uitest screenCap -p ${shq(remote)}`, ext: 'png' },
  ]
  const dir = await scratchDir('dsh-hdc-')
  const remotes = []
  try {
    const failures = []
    for (const attempt of attempts) {
      const remote = `${REMOTE_TMP}/dsh_hdc_${stamp}.${attempt.ext}`
      remotes.push(remote)
      const local = path.join(dir, `screen.${attempt.ext}`)
      const command = attempt.command(remote)
      const ran = await shell(hdcPath, serial, command, { signal, timeoutMs: 30_000 })
      const pulled = await runHdc(hdcPath, serial, ['file', 'recv', remote, local], { signal, timeoutMs: 30_000 })
      if (pulled.ok && existsSync(local)) {
        const data = await readFile(local)
        const mediaType = sniffImageMediaType(data)
        if (mediaType !== undefined) return { data, mediaType }
        failures.push(`${command}: the captured file was not a recognizable image`)
      } else {
        failures.push(`${command}: ${pulled.ok ? 'no file was produced' : failureText(pulled)}`)
      }
      if (!ran.ok) failures.push(`${command}: ${failureText(ran)}`)
      await rm(local, { force: true }).catch(() => {})
    }
    throw toolError(
      `screenshot failed. ${failures.join('; ')}. The device may be locked, or its shell may lack these commands.`,
      'HDC_SCREENSHOT_FAILED',
    )
  } finally {
    // Remove every remote scratch file on every path, including a total
    // failure: a build that wrote a non-image file would otherwise leave it
    // behind. The cleanup is awaited so it cannot be lost when the process
    // exits, and it covers both attempts rather than only the one that ran.
    if (remotes.length > 0) {
      const list = remotes.map((remote) => shq(remote)).join(' ')
      await shell(hdcPath, serial, `rm -f ${list}`, { timeoutMs: 10_000 }).catch(() => {})
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Clamp an integer argument into a range, taking the default when absent. */
function clampInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Require one string argument, naming it in the error. */
function requireArg(value, name, action) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw toolError(`${action} requires ${name}`, 'HDC_BAD_ARGS')
  }
  return value.trim()
}

/** Require one numeric argument, naming it in the error. */
function requireNumber(value, name, action) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw toolError(`${action} requires ${name}`, 'HDC_BAD_ARGS')
  }
  return Math.trunc(value)
}

/**
 * Resolve an `hdc_app` call into the exact command plan, validating its own
 * arguments before any device round-trip.
 * @returns the plan the caller executes.
 */
function planAppAction(args, workdir) {
  const { action } = args
  switch (action) {
    case 'install': {
      const localPath = path.resolve(workdir, requireArg(args.package, 'package', 'install'))
      if (!existsSync(localPath)) throw toolError(`no such package file: ${localPath}`, 'HDC_PACKAGE_NOT_FOUND')
      return { kind: 'install', localPath }
    }
    case 'uninstall':
      return { kind: 'uninstall', bundle: requireArg(args.package, 'package', 'uninstall'), keepData: args.keep_data === true }
    case 'start':
      return {
        kind: 'start',
        bundle: requireArg(args.bundle, 'bundle', 'start'),
        ability: typeof args.ability === 'string' && args.ability.trim() !== '' ? args.ability.trim() : 'EntryAbility',
      }
    case 'stop':
      return { kind: 'stop', bundle: requireArg(args.bundle, 'bundle', 'stop') }
    case 'current':
      return { kind: 'current' }
    case 'list':
      return { kind: 'list' }
    default:
      throw toolError(`unsupported action: ${String(action)}`, 'HDC_BAD_ARGS')
  }
}

/**
 * Resolve an `hdc_file` call into its exact transfer plan, validating its own
 * arguments before any device round-trip.
 */
function planFileAction(args, workdir) {
  const { action } = args
  if (action === 'shell') return { kind: 'shell', command: requireArg(args.command, 'command', 'shell') }
  const remote = requireArg(args.remote, 'remote', action)
  const localPath = path.resolve(workdir, requireArg(args.local, 'local', action))
  if (action === 'send') {
    if (!existsSync(localPath)) throw toolError(`no such local file: ${localPath}`, 'HDC_FILE_NOT_FOUND')
    return { kind: 'send', remote, localPath }
  }
  if (action === 'recv') return { kind: 'recv', remote, localPath }
  throw toolError(`unsupported action: ${String(action)}`, 'HDC_BAD_ARGS')
}

/** Translate an `hdc_input` call into `uitest uiInput` arguments. */
function buildInputCommand(args) {
  const { action } = args
  switch (action) {
    case 'click':
    case 'doubleClick':
    case 'longClick':
      return `${action} ${requireNumber(args.x, 'x', action)} ${requireNumber(args.y, 'y', action)}`
    case 'swipe':
    case 'drag':
    case 'fling': {
      const parts = [
        action,
        requireNumber(args.x, 'x', action),
        requireNumber(args.y, 'y', action),
        requireNumber(args.to_x, 'to_x', action),
        requireNumber(args.to_y, 'to_y', action),
      ]
      parts.push(clampInteger(args.duration_ms, action === 'fling' ? 500 : 600, 100, 40_000))
      return parts.join(' ')
    }
    case 'text':
      return `text ${shq(requireArg(args.text, 'text', 'text'))}`
    case 'key':
      return `keyEvent ${shq(requireArg(args.key, 'key', 'key'))}`
    default:
      throw toolError(`unsupported input action: ${String(action)}`, 'HDC_BAD_ARGS')
  }
}

/**
 * Run one prepared `uitest uiInput` command.
 *
 * Kept apart from the tool body so the HTTP route sends the identical sequence,
 * including the failure wording that both the model and a browser caller read:
 * two copies of this would eventually disagree about the timeout or the
 * success check.
 *
 * @returns the command's trimmed output, or `undefined` when it printed none.
 */
async function runInputCommand(hdcPath, serial, command, action, signal) {
  const outcome = await shell(hdcPath, serial, `uitest uiInput ${command}`, { signal, timeoutMs: 30_000 })
  ensureOk(outcome, `input ${action}`)
  const output = outcome.stdout.trim()
  return output === '' ? undefined : output
}

/**
 * Dump the interface hierarchy and render it for a caller.
 *
 * Shared by the `hdc_ui_tree` tool and the `/hdc/uitree` route so the two
 * cannot drift on the remote file handling, the default node filter, or the
 * truncation threshold a browser and a model both have to size against.
 *
 * @param allNodes - keep containers and unlabeled nodes, not just tap targets.
 * @returns the rendered content, whether it was clipped, and the same nodes as
 *   an outline a caller can draw as a tree.
 */
async function dumpInterface(hdcPath, serial, allNodes, signal) {
  const remote = `${REMOTE_TMP}/dsh_layout_${Date.now()}.json`
  ensureOk(
    await shell(hdcPath, serial, `uitest dumpLayout -p ${shq(remote)}`, { signal, timeoutMs: 60_000 }),
    'dumping the interface hierarchy',
  )
  const dir = await scratchDir('dsh-hdc-layout-')
  try {
    const local = path.join(dir, 'layout.json')
    await pullTo(hdcPath, serial, remote, local, { signal })
    const nodes = summarizeLayout(await readFile(local, 'utf8'))
    // Keep labeled nodes plus unlabeled controls: an icon button with no
    // text, id, or description is exactly the tap target this tool exists
    // to locate, so filtering on text alone would hide it.
    const shown = allNodes
      ? nodes
      : nodes.filter((node) => node.text !== undefined || node.clickable)
    const body = shown.map(formatLayoutNode).join('\n')
    return {
      content: clip(body === '' ? '(no nodes matched)' : body),
      truncated: body.length > 20_000,
      // The same nodes again, as an outline: the text above is one flat line per
      // node because that is what a model reads well, but the dump is a tree and
      // a panel has to draw it as one. Sending the structure here keeps a second
      // device round-trip out of the panel's refresh path.
      rows: outlineLayout(nodes, shown),
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await shell(hdcPath, serial, `rm -f ${shq(remote)}`, { timeoutMs: 10_000 }).catch(() => {})
  }
}

/**
 * Read the recent log tail and filter it.
 *
 * The `-z` choice and the crash-marker list are device- and format-specific
 * findings, not presentation choices, so both callers route through here: a
 * second copy would silently lose a marker or re-introduce the `-x` pairing
 * that the client rejects.
 *
 * @returns how many lines were scanned, how many matched, and the rendered tail.
 */
async function readLogs(hdcPath, serial, args, signal) {
  const lines = clampInteger(args.lines, 800, 1, 20_000)
  const maxMatches = clampInteger(args.max_matches, 120, 1, 2_000)
  // `-z` reads the last N lines and exits. It cannot be combined with `-x`,
  // which reads the whole buffer and exits: hilog rejects the pair with
  // "Mutlti commands can't be used in combination [CODE: -31]". `-z` alone
  // already returns, so no streaming read needs killing.
  const outcome = await shell(hdcPath, serial, `hilog -z ${lines}`, { signal, timeoutMs: 60_000 })
  ensureOk(outcome, 'reading logs')

  const keyword = typeof args.keyword === 'string' && args.keyword.trim() !== ''
    ? args.keyword.trim().toLowerCase()
    : undefined
  // Crash markers only. Each one is specific enough that ordinary traffic
  // does not match: a bare "fault" or "exception" would, because subsystem
  // and lifecycle lines contain them (FaultLeakDetectorManager, telemetry
  // fault, RecordLifeCycleExceptionEvent, "Kill Reason:app exit").
  const crashMarkers = [
    /crash/iu,
    /\bfatal\b/iu,
    /SIGSEGV|SIGABRT|SIGBUS/u,
    /uncaught exception/iu,
    /JS[_ ]ERROR|JsError/u,
    /FaultLogger/u,
  ]
  const all = outcome.stdout.split('\n')
  const matched = all.filter((line) => {
    if (line.trim() === '') return false
    if (keyword !== undefined && !line.toLowerCase().includes(keyword)) return false
    if (args.crash === true && !crashMarkers.some((marker) => marker.test(line))) return false
    return true
  })
  const kept = matched.slice(-maxMatches)
  return {
    scanned: all.length,
    matches: matched.length,
    content: clip(kept.length === 0 ? '(no matching lines)' : kept.join('\n'), 18_000),
  }
}

/** The device argument shared by every tool except the device list. */
const DEVICE_PARAM = {
  type: 'string',
  description: 'Connect key from hdc_devices. Omit when exactly one device is attached.',
}

/**
 * Register every `hdc_*` tool.
 * @param ctx - the plugin context, which must provide `tools`.
 * @param config - resolved plugin config.
 */
export function registerTools(ctx, config) {
  const { tools } = ctx

  tools.register({
    name: 'hdc_devices',
    description: 'List HarmonyOS devices attached through hdc, with the connect key that the other hdc tools take as their device argument. '
      + 'Call this first when a device call reports that it cannot choose a target.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hdcPath', 'devices'],
        properties: {
          hdcPath: { type: 'string' },
          devices: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.devices.length === 0
          ? `No HarmonyOS device is attached.\nhdc: ${value.hdcPath}`
          : `HarmonyOS devices (${value.devices.length}):\n${value.devices.map((serial) => `- ${serial}`).join('\n')}\nhdc: ${value.hdcPath}`,
      }],
    },
    async execute(_args, exec) {
      const hdcPath = requireHdc(runtime(config, exec))
      // A listing is the one caller that means "what is attached right now", so
      // it asks the device instead of reusing the resolution cache.
      return { hdcPath, devices: await listSerials(hdcPath, { signal: exec.signal, fresh: true }) }
    },
    presentCall: () => ({ card: 'generic', title: 'List HarmonyOS devices', kind: 'other' }),
  })

  tools.register({
    name: 'hdc_screenshot',
    description: 'Capture a HarmonyOS device screen and return the image itself, so what the device shows can be inspected directly. '
      + 'Coordinates for hdc_input and hdc_ui_tree are device pixels measured on this image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device: DEVICE_PARAM,
        save_path: {
          type: 'string',
          description: 'Local path that also keeps a PNG copy. Relative paths resolve against the session directory.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'image'],
        properties: {
          device: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
              originalDimensions: {
                type: 'object',
                additionalProperties: false,
                required: ['width', 'height'],
                properties: {
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
              },
            },
          },
          savedPath: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const { image } = value
        const scaled = image.originalDimensions === undefined
          ? ''
          : ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; `
            + 'tap and swipe coordinates must be in the original device pixels)'
        const saved = value.savedPath === undefined ? '' : `\nSaved: ${value.savedPath}`
        return [
          {
            type: 'text',
            text: `<device>${value.device}</device>\n<type>screenshot</type>\n<content>\n`
              + `${image.width}x${image.height} px, ${image.bytes} bytes${scaled}${saved}\n</content>`,
          },
          {
            type: 'image',
            attachment: {
              attachmentId: image.attachmentId,
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              ...image.name === undefined ? {} : { name: image.name },
              ...image.originalDimensions === undefined
                ? {}
                : { originalDimensions: { ...image.originalDimensions } },
            },
          },
        ]
      },
      presentationMeta: (_args, value) => value.savedPath === undefined
        ? { device: value.device }
        : { device: value.device, path: value.savedPath },
    },
    async execute(args, exec) {
      const rt = runtime(config, exec)
      const hdcPath = requireHdc(rt)
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      const captured = await captureScreen(hdcPath, serial, exec.signal)

      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw toolError('cannot return the screenshot as an image: no attachment service is mounted', 'HDC_ATTACHMENT_UNAVAILABLE')
      }
      let savedPath
      if (typeof args.save_path === 'string' && args.save_path.trim() !== '') {
        savedPath = path.resolve(rt.workdir, args.save_path.trim())
        await mkdir(path.dirname(savedPath), { recursive: true })
        await writeFile(savedPath, captured.data)
      }
      const ref = await attachments.saveImage({
        data: captured.data,
        mediaType: captured.mediaType,
        name: `hdc-screenshot-${Date.now()}.${captured.mediaType === 'image/png' ? 'png' : 'jpg'}`,
      })
      return {
        device: serial,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
          ...ref.originalDimensions === undefined
            ? {}
            : { originalDimensions: { ...ref.originalDimensions } },
        },
        ...savedPath === undefined ? {} : { savedPath },
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.device === undefined ? 'Screenshot device' : `Screenshot ${args.device}`,
      kind: 'read',
    }),
  })

  tools.register({
    name: 'hdc_input',
    description: 'Tap, long press, double tap, swipe, drag, type text, or press a key on the device through `uitest uiInput`. '
      + 'Coordinates are device pixels read from an hdc_screenshot image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        device: DEVICE_PARAM,
        action: {
          type: 'string',
          enum: ['click', 'doubleClick', 'longClick', 'swipe', 'drag', 'fling', 'text', 'key'],
          description: 'click, doubleClick, and longClick need x and y. swipe, drag, and fling need x, y, to_x, and to_y. '
            + 'text types into the focused field. key presses a named key such as Back or Home.',
        },
        x: { type: 'integer', description: 'Tap or gesture start x in device pixels.' },
        y: { type: 'integer', description: 'Tap or gesture start y in device pixels.' },
        to_x: { type: 'integer', description: 'Gesture end x, for swipe, drag, and fling.' },
        to_y: { type: 'integer', description: 'Gesture end y, for swipe, drag, and fling.' },
        duration_ms: {
          type: 'integer',
          description: 'Gesture speed in pixels per second for swipe and drag, or duration for fling. Defaults to 600, or 500 for fling.',
        },
        text: { type: 'string', description: 'Text to type when action is text.' },
        key: { type: 'string', description: 'Key name when action is key, such as Back, Home, Power, or VolumeUp.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'command'],
        properties: {
          device: { type: 'string' },
          command: { type: 'string' },
          output: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Ran on ${value.device}: uitest uiInput ${value.command}`
          + (value.output === undefined ? '' : `\n${value.output}`),
      }],
    },
    async execute(args, exec) {
      // Build the command first: an incomplete gesture should fail on the
      // arguments rather than after a pointless device round-trip.
      const command = buildInputCommand(args)
      const hdcPath = requireHdc(runtime(config, exec))
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      const output = await runInputCommand(hdcPath, serial, command, args.action, exec.signal)
      return { device: serial, command, ...output === undefined ? {} : { output } }
    },
    presentCall: (args) => ({ card: 'generic', title: `Input ${args.action}`, kind: 'execute' }),
  })

  tools.register({
    name: 'hdc_ui_tree',
    description: 'Dump the current interface hierarchy with `uitest dumpLayout`, reporting each control with its bounds, text, id, and type, '
      + 'plus the center point to tap. Use it instead of guessing coordinates for a button or text field.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device: DEVICE_PARAM,
        all_nodes: { type: 'boolean', description: 'Keep every node, including containers without text. Defaults to false.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'content', 'truncated'],
        properties: {
          device: { type: 'string' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Interface hierarchy of ${value.device}${value.truncated ? ' (truncated)' : ''}\n<content>\n${value.content}\n</content>`,
      }],
    },
    async execute(args, exec) {
      const hdcPath = requireHdc(runtime(config, exec))
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      const dumped = await dumpInterface(hdcPath, serial, args.all_nodes === true, exec.signal)
      // The outline is the panel's view of the dump. The model reads the flat
      // text, so carrying the structure here would only spend context on a
      // second copy of the same dump — and this tool's output schema does not
      // declare it.
      return { device: serial, content: dumped.content, truncated: dumped.truncated }
    },
    presentCall: () => ({ card: 'generic', title: 'Dump interface hierarchy', kind: 'read' }),
  })

  tools.register({
    name: 'hdc_app',
    description: 'Manage applications on the device: install a .hap/.hsp/.app, uninstall a bundle, start or stop an ability, '
      + 'dump the mission list showing the running abilities, or list installed bundles.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        device: DEVICE_PARAM,
        action: {
          type: 'string',
          enum: ['install', 'uninstall', 'start', 'stop', 'current', 'list'],
          description: 'install and uninstall need package. start and stop need bundle. current dumps the mission list, '
            + 'where the first row is usually the foreground ability; '
            + 'list reports installed bundles.',
        },
        package: { type: 'string', description: 'Local .hap/.hsp/.app path for install, or the bundle name for uninstall.' },
        bundle: { type: 'string', description: 'Bundle name for start or stop.' },
        ability: { type: 'string', description: 'Ability name for start. Defaults to EntryAbility.' },
        keep_data: { type: 'boolean', description: 'For uninstall, keep the application data and cache directories.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'action', 'output'],
        properties: {
          device: { type: 'string' },
          action: { type: 'string' },
          output: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.action} on ${value.device}:\n<content>\n${value.output}\n</content>`,
      }],
    },
    async execute(args, exec) {
      // Validate the action's own arguments before any device round-trip, so a
      // malformed call fails on what the caller can fix.
      const rt = runtime(config, exec)
      const plan = planAppAction(args, rt.workdir)
      const hdcPath = requireHdc(rt)
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      const options = { signal: exec.signal, timeoutMs: 180_000 }
      let outcome
      switch (plan.kind) {
        case 'install':
          outcome = await runHdc(hdcPath, serial, ['install', '-r', plan.localPath], options)
          break
        case 'uninstall':
          outcome = await runHdc(hdcPath, serial, ['uninstall', ...plan.keepData ? ['-k'] : [], plan.bundle], options)
          break
        case 'start':
          outcome = await shell(hdcPath, serial, `aa start -a ${shq(plan.ability)} -b ${shq(plan.bundle)}`, options)
          break
        case 'stop':
          outcome = await shell(hdcPath, serial, `aa force-stop ${shq(plan.bundle)}`, options)
          break
        case 'current':
          outcome = await shell(hdcPath, serial, 'aa dump -l', options)
          break
        case 'list':
          outcome = await shell(hdcPath, serial, 'bm dump -a', options)
          break
        default:
          throw toolError(`unsupported action: ${String(args.action)}`, 'HDC_BAD_ARGS')
      }
      ensureOk(outcome, args.action)
      const text = `${outcome.stdout}${outcome.stderr}`.trim()
      return { device: serial, action: args.action, output: clip(text === '' ? '(no output)' : text, 12_000) }
    },
    presentCall: (args) => ({ card: 'generic', title: `${args.action} application`, kind: 'execute' }),
  })

  tools.register({
    name: 'hdc_log',
    description: 'Read recent device logs with `hilog`, optionally keeping only lines that mention a keyword, '
      + 'or only crash and fault markers. Use it to explain what happened after an interaction.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device: DEVICE_PARAM,
        keyword: { type: 'string', description: 'Case-insensitive text a line must contain to be kept.' },
        lines: { type: 'integer', description: 'How many recent log lines to scan. Defaults to 800.' },
        max_matches: { type: 'integer', description: 'How many matching lines to return. Defaults to 120.' },
        crash: { type: 'boolean', description: 'Keep only lines that look like a crash, fault, or uncaught exception.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'scanned', 'matches', 'content'],
        properties: {
          device: { type: 'string' },
          scanned: { type: 'integer' },
          matches: { type: 'integer' },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.matches} matching line(s) from the last ${value.scanned} on ${value.device}\n<content>\n${value.content}\n</content>`,
      }],
    },
    async execute(args, exec) {
      const hdcPath = requireHdc(runtime(config, exec))
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      return { device: serial, ...await readLogs(hdcPath, serial, args, exec.signal) }
    },
    presentCall: () => ({ card: 'generic', title: 'Read device logs', kind: 'read' }),
  })

  tools.register({
    name: 'hdc_file',
    description: 'Copy a file to or from the device with `hdc file send` and `hdc file recv`, or run a shell command on the device. '
      + 'This is the general-purpose device command tool; the dedicated tools cover screenshots, logs, input, and applications.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        device: DEVICE_PARAM,
        action: { type: 'string', enum: ['send', 'recv', 'shell'], description: 'Transfer direction, or shell for a remote command.' },
        local: { type: 'string', description: 'Local source for send, or local destination for recv.' },
        remote: { type: 'string', description: 'Device destination for send, or device source for recv.' },
        command: { type: 'string', description: 'Device shell command when action is shell.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'action', 'output'],
        properties: {
          device: { type: 'string' },
          action: { type: 'string' },
          output: { type: 'string' },
          localPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.action} on ${value.device}${value.localPath === undefined ? '' : `\nlocal: ${value.localPath}`}`
          + `\n<content>\n${value.output}\n</content>`,
      }],
    },
    async execute(args, exec) {
      const rt = runtime(config, exec)
      // Resolve every argument this action needs before contacting the device.
      const plan = planFileAction(args, rt.workdir)
      const hdcPath = requireHdc(rt)
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      const options = { signal: exec.signal, timeoutMs: 300_000 }

      if (plan.kind === 'shell') {
        const outcome = await shell(hdcPath, serial, plan.command, options)
        ensureOk(outcome, 'remote shell')
        const text = `${outcome.stdout}${outcome.stderr}`.trim()
        return { device: serial, action: 'shell', output: clip(text === '' ? '(no output)' : text) }
      }
      if (plan.kind === 'send') {
        ensureOk(await runHdc(hdcPath, serial, ['file', 'send', plan.localPath, plan.remote], options), 'sending file')
        return { device: serial, action: 'send', output: `${plan.localPath} -> ${plan.remote}`, localPath: plan.localPath }
      }
      await mkdir(path.dirname(plan.localPath), { recursive: true })
      ensureOk(await runHdc(hdcPath, serial, ['file', 'recv', plan.remote, plan.localPath], options), 'receiving file')
      return { device: serial, action: 'recv', output: `${plan.remote} -> ${plan.localPath}`, localPath: plan.localPath }
    },
    presentCall: (args) => ({ card: 'generic', title: `File ${args.action}`, kind: 'execute' }),
  })

  tools.register({
    name: 'hdc_record',
    description: 'Record the device screen to a local video file for a bounded number of seconds and report where it was saved. '
      + 'The result is a file path, not a viewable image. Frames are captured in sequence and joined into an mp4, '
      + 'because this HarmonyOS line ships no `screenrecord` command; the playback rate follows the rate the device could '
      + 'actually capture at, which is usually a few frames per second.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device: DEVICE_PARAM,
        seconds: { type: 'integer', description: 'Recording length from 1 to 180. Defaults to 10.' },
        save_path: { type: 'string', description: 'Local .mp4 destination. Defaults to a timestamped file in the session directory.' },
        width: { type: 'integer', description: 'Capture width in device pixels. Defaults to the screen width; a smaller width downloads faster.' },
        height: { type: 'integer', description: 'Capture height in device pixels. Defaults to the screen height.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'savedPath', 'seconds', 'bytes', 'kind', 'frames'],
        properties: {
          device: { type: 'string' },
          savedPath: { type: 'string' },
          seconds: { type: 'number' },
          bytes: { type: 'integer' },
          kind: { type: 'string' },
          frames: { type: 'integer' },
          fps: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded ${value.seconds}s on ${value.device} -> ${value.savedPath} (${value.bytes} bytes)\n`
          + `<content>\n${value.frames} frames${value.fps === undefined ? '' : ` at ${value.fps} fps`}, `
          + `${value.kind === 'video' ? 'an mp4' : 'a frame sequence: ffmpeg was unavailable or refused, so the frames were kept'}`
          + `${value.note === undefined ? '' : ` (${value.note})`}\n</content>`,
      }],
    },
    async execute(args, exec) {
      const rt = runtime(config, exec)
      const hdcPath = requireHdc(rt)
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      const seconds = clampInteger(args.seconds, 10, 1, 180)
      const savedPath = path.resolve(
        rt.workdir,
        typeof args.save_path === 'string' && args.save_path.trim() !== ''
          ? args.save_path.trim()
          : `hdc-record-${Date.now()}.mp4`,
      )
      const recorded = await recordScreen(hdcPath, serial, {
        seconds,
        savePath: savedPath,
        ffmpegPath: discoverFfmpeg(config.ffmpegPath),
        width: typeof args.width === 'number' ? args.width : undefined,
        height: typeof args.height === 'number' ? args.height : undefined,
        signal: exec.signal,
      })
      return {
        device: serial,
        savedPath: recorded.savedPath,
        seconds: recorded.seconds,
        bytes: recorded.bytes,
        kind: recorded.kind,
        frames: recorded.frames,
        ...recorded.fps === undefined ? {} : { fps: recorded.fps },
        ...recorded.note === undefined ? {} : { note: recorded.note },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Record the device screen', kind: 'execute' }),
  })
}

/**
 * Flatten a `uitest dumpLayout` document into nodes carrying absolute bounds.
 *
 * The document is a tree of `{ attributes, children }` nodes whose `bounds`
 * value is the string form `"[left,top][right,bottom]"`, measured in screen
 * pixels rather than relative to the parent. Newer builds may report a
 * rectangle object instead, so both shapes are read here.
 *
 * `depth` is the node's distance from the root of the document, counted over
 * every node including the containers this function drops. It is kept so a tree
 * view can be rebuilt from the flat list; the text rendering ignores it.
 *
 * @returns nodes in document order.
 */
function summarizeLayout(raw) {
  let document
  try {
    document = JSON.parse(raw)
  } catch {
    return []
  }
  const nodes = []
  const visit = (node, depth) => {
    if (node === null || typeof node !== 'object') return
    const attributes = node.attributes ?? node
    const rect = readRect(attributes.bounds ?? attributes.rect)
    const type = stringField(attributes, ['type', 'componentType'])
    if (type !== undefined) {
      nodes.push({
        type,
        text: firstNonEmpty(
          stringField(attributes, ['text']),
          stringField(attributes, ['id']),
          stringField(attributes, ['description', 'accessibilityId']),
        ),
        x: rect?.x ?? 0,
        y: rect?.y ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        clickable: attributes.clickable === 'true' || attributes.clickable === true,
        depth,
      })
    }
    const children = node.children
    if (Array.isArray(children)) for (const child of children) visit(child, depth + 1)
  }
  visit(document, 0)
  return nodes
}

/**
 * Turn flat nodes into an outline whose depth counts only kept ancestors.
 *
 * The document's own depth cannot be used directly. A phone screen nests a
 * labeled `Text` under twenty containers and a `GridItem` under four, so a tree
 * drawn at raw depth is mostly empty indentation — and the deeper half of it
 * scrolls out of a panel column that is ~40% of the window. Compressing to the
 * depth of the nearest *shown* ancestor keeps the parent-child relation the
 * user is looking for (this icon sits inside that card) without the containers
 * nobody asked to see. `all_nodes` shows the containers, so it naturally gets
 * the raw nesting back.
 *
 * `hasChildren` marks a row whose descendants follow it, so a renderer can draw
 * a caret that actually opens something.
 *
 * @param nodes - every node of the dump, in document order.
 * @param shown - the subset to keep, in the same order and drawn from `nodes`.
 * @returns one row per shown node, carrying what a tree needs to be drawn.
 */
function outlineLayout(nodes, shown) {
  const keep = new Set(shown)
  /** The kept chain of ancestors above the node being visited: {row, depth}. */
  const chain = []
  const rows = []
  for (const node of nodes) {
    if (!keep.has(node)) continue
    // Everything at this depth or deeper that is still on the chain is a
    // closing branch, not an ancestor of what comes next.
    while (chain.length > 0 && chain[chain.length - 1].depth >= node.depth) chain.pop()
    const parent = chain[chain.length - 1]
    if (parent !== undefined) rows[parent.row].hasChildren = true
    rows.push({
      depth: chain.length,
      type: node.type,
      ...node.text === undefined ? {} : { text: node.text },
      clickable: node.clickable,
      tap: { x: node.x + Math.floor(node.width / 2), y: node.y + Math.floor(node.height / 2) },
      hasChildren: false,
    })
    chain.push({ row: rows.length - 1, depth: node.depth })
  }
  return rows
}

/** Candidates for one screen rectangle, in the forms `dumpLayout` has used. */
function readRect(value) {
  if (typeof value === 'string') return readBoundsString(value)
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    const numbers = value.filter((entry) => typeof entry === 'number')
    if (numbers.length === 4) {
      const [left, top, right, bottom] = numbers
      return { x: left, y: top, width: right - left, height: bottom - top }
    }
    return undefined
  }
  const x = numberField(value, ['left', 'x', 'leftTopX'])
  const y = numberField(value, ['top', 'y', 'leftTopY'])
  if (x === undefined || y === undefined) return undefined
  const width = numberField(value, ['width'])
  const height = numberField(value, ['height'])
  const right = numberField(value, ['right', 'rightBottomX'])
  const bottom = numberField(value, ['bottom', 'rightBottomY'])
  return {
    x,
    y,
    width: width ?? (right === undefined ? 0 : right - x),
    height: height ?? (bottom === undefined ? 0 : bottom - y),
  }
}

/**
 * Parse the `"[left,top][right,bottom]"` bounds string.
 *
 * A malformed value yields `undefined` rather than a zero rectangle, so a bad
 * dump reports no geometry instead of claiming every control sits at the origin.
 */
function readBoundsString(text) {
  const match = /^\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*$/u.exec(text)
  if (match === null) return undefined
  const [left, top, right, bottom] = match.slice(1).map(Number)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** First non-empty string field among the given keys. */
function stringField(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** First numeric field among the given keys, accepting numeric strings. */
function numberField(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

/** First defined, non-empty string. */
function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== '')
}

/** Render one layout node as a single line naming its bounds and tap point. */
function formatLayoutNode(node) {
  const centerX = node.x + Math.floor(node.width / 2)
  const centerY = node.y + Math.floor(node.height / 2)
  const label = node.text === undefined ? '' : ` ${JSON.stringify(node.text)}`
  const clickable = node.clickable ? ' clickable' : ''
  return `${node.type}${label}${clickable} @ [${node.x},${node.y}][${node.width}x${node.height}] tap (${centerX}, ${centerY})`
}

/**
 * Reusable device operations and the pieces the tool family is built from.
 *
 * `service.js` and the `/hdc` routes import these rather than re-deriving the
 * command lines, so the HTTP surface and the model-facing tools stay in step.
 */
export {
  summarizeLayout,
  outlineLayout,
  readRect,
  readBoundsString,
  formatLayoutNode,
  captureScreen,
  buildInputCommand,
  runInputCommand,
  dumpInterface,
  readLogs,
  requireHdc,
  requireDevice,
  listSerials,
  toolError,
  runtime,
  REMOTE_TMP,
}
