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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
      + 'or set hdcPath in the hdc-tools plugin settings to the full path of the hdc executable.',
      'HDC_NOT_FOUND',
    )
  }
  return rt.hdcPath
}

/** List attached connect keys. */
async function listSerials(hdcPath, options) {
  const outcome = await runHdc(hdcPath, undefined, ['list', 'targets'], options)
  ensureOk(outcome, 'listing devices')
  return parseTargets(outcome.stdout)
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
 * `snapshot_display` is preferred; `uitest screenCap` covers builds without it.
 * Both are attempted because which one exists varies across OpenHarmony and
 * HarmonyOS NEXT versions, and a build may report success without writing.
 */
async function captureScreen(hdcPath, serial, signal) {
  const stamp = `${Date.now()}`
  const remote = `${REMOTE_TMP}/dsh_hdc_${stamp}.png`
  const commands = [`snapshot_display -f ${shq(remote)}`, `uitest screenCap -p ${shq(remote)}`]
  const dir = await scratchDir('dsh-hdc-')
  try {
    const local = path.join(dir, 'screen.png')
    const failures = []
    for (const command of commands) {
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
    // Remove the remote scratch file on every path, including a total failure:
    // a build that wrote a non-image file would otherwise leave it behind. The
    // cleanup is awaited so it cannot be lost when the process exits.
    await shell(hdcPath, serial, `rm -f ${shq(remote)}`, { timeoutMs: 10_000 }).catch(() => {})
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
      return { hdcPath, devices: await listSerials(hdcPath, { signal: exec.signal }) }
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
        name: `hdc-screenshot-${Date.now()}.png`,
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
      const outcome = await shell(hdcPath, serial, `uitest uiInput ${command}`, { signal: exec.signal, timeoutMs: 30_000 })
      ensureOk(outcome, `input ${args.action}`)
      const output = outcome.stdout.trim()
      return { device: serial, command, ...output === '' ? {} : { output } }
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
      const remote = `${REMOTE_TMP}/dsh_layout_${Date.now()}.json`
      ensureOk(
        await shell(hdcPath, serial, `uitest dumpLayout -p ${shq(remote)}`, { signal: exec.signal, timeoutMs: 60_000 }),
        'dumping the interface hierarchy',
      )
      const dir = await scratchDir('dsh-hdc-layout-')
      try {
        const local = path.join(dir, 'layout.json')
        await pullTo(hdcPath, serial, remote, local, { signal: exec.signal })
        const nodes = summarizeLayout(await readFile(local, 'utf8'))
        // Keep labeled nodes plus unlabeled controls: an icon button with no
        // text, id, or description is exactly the tap target this tool exists
        // to locate, so filtering on text alone would hide it.
        const shown = args.all_nodes === true
          ? nodes
          : nodes.filter((node) => node.text !== undefined || node.clickable)
        const body = shown.map(formatLayoutNode).join('\n')
        return {
          device: serial,
          content: clip(body === '' ? '(no nodes matched)' : body),
          truncated: body.length > 20_000,
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        await shell(hdcPath, serial, `rm -f ${shq(remote)}`, { timeoutMs: 10_000 }).catch(() => {})
      }
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
      const lines = clampInteger(args.lines, 800, 1, 20_000)
      const maxMatches = clampInteger(args.max_matches, 120, 1, 2_000)
      // `-x` releases the buffer and exits; a plain `hilog` would stream until killed.
      const outcome = await shell(hdcPath, serial, `hilog -x -n ${lines}`, { signal: exec.signal, timeoutMs: 60_000 })
      ensureOk(outcome, 'reading logs')

      const keyword = typeof args.keyword === 'string' && args.keyword.trim() !== ''
        ? args.keyword.trim().toLowerCase()
        : undefined
      const crashMarkers = [/crash/iu, /fault/iu, /exception/iu, /SIGSEGV/u, /SIGABRT/u, /Reason:/u]
      const all = outcome.stdout.split('\n')
      const matched = all.filter((line) => {
        if (line.trim() === '') return false
        if (keyword !== undefined && !line.toLowerCase().includes(keyword)) return false
        if (args.crash === true && !crashMarkers.some((marker) => marker.test(line))) return false
        return true
      })
      const kept = matched.slice(-maxMatches)
      return {
        device: serial,
        scanned: all.length,
        matches: matched.length,
        content: clip(kept.length === 0 ? '(no matching lines)' : kept.join('\n'), 18_000),
      }
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
      + 'The result is a file path, not a viewable image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device: DEVICE_PARAM,
        seconds: { type: 'integer', description: 'Recording length from 1 to 180. Defaults to 10.' },
        save_path: { type: 'string', description: 'Local .mp4 destination. Defaults to a timestamped file in the session directory.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['device', 'savedPath', 'seconds', 'bytes'],
        properties: {
          device: { type: 'string' },
          savedPath: { type: 'string' },
          seconds: { type: 'integer' },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded ${value.seconds}s on ${value.device} -> ${value.savedPath} (${value.bytes} bytes)`,
      }],
    },
    async execute(args, exec) {
      const rt = runtime(config, exec)
      const hdcPath = requireHdc(rt)
      const serial = await requireDevice(hdcPath, args.device, { signal: exec.signal })
      const seconds = clampInteger(args.seconds, 10, 1, 180)
      const remote = `${REMOTE_TMP}/dsh_rec_${Date.now()}.mp4`
      ensureOk(
        await shell(hdcPath, serial, `screenrecord --time-limit ${seconds} ${shq(remote)}`, {
          signal: exec.signal,
          timeoutMs: (seconds + 30) * 1_000,
        }),
        'recording the screen',
      )
      const savedPath = path.resolve(
        rt.workdir,
        typeof args.save_path === 'string' && args.save_path.trim() !== ''
          ? args.save_path.trim()
          : `hdc-record-${Date.now()}.mp4`,
      )
      await mkdir(path.dirname(savedPath), { recursive: true })
      try {
        await pullTo(hdcPath, serial, remote, savedPath, { signal: exec.signal, timeoutMs: 300_000 })
      } finally {
        await shell(hdcPath, serial, `rm -f ${shq(remote)}`, { timeoutMs: 10_000 }).catch(() => {})
      }
      return { device: serial, savedPath, seconds, bytes: (await stat(savedPath)).size }
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
  const visit = (node) => {
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
      })
    }
    const children = node.children
    if (Array.isArray(children)) for (const child of children) visit(child)
  }
  visit(document)
  return nodes
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

export { summarizeLayout, readRect, readBoundsString, formatLayoutNode }
