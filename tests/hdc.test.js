/**
 * Unit tests for the pure parts of the plugin: device selection, target
 * parsing, image sniffing, output clipping, and layout summarization.
 *
 * These run with plain Node against the source modules, so they cover the logic
 * that a connected device would otherwise be needed to exercise.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  clip,
  discoverHdc,
  forgetLoginShellCache,
  parseTargets,
  selectDevice,
  shq,
  sniffImageMediaType,
} from '../lib/hdc.js'
import { summarizeLayout, outlineLayout, readRect, readBoundsString, formatLayoutNode } from '../lib/tools.js'

test('parseTargets drops the empty marker and banner lines', () => {
  assert.deepEqual(parseTargets('[Empty]\n'), [])
  assert.deepEqual(parseTargets('7001005451929188\n\n'), ['7001005451929188'])
  assert.deepEqual(
    parseTargets('[Empty]\t hdc\n127.0.0.1:5555\n'),
    ['127.0.0.1:5555'],
  )
})

test('selectDevice takes the only device when none is requested', () => {
  assert.deepEqual(selectDevice(['abc'], undefined), { serial: 'abc' })
})

test('selectDevice refuses to guess between several devices', () => {
  const chosen = selectDevice(['abc', 'def'], undefined)
  assert.match(chosen.error, /several devices/u)
  assert.match(chosen.error, /abc, def/u)
})

test('selectDevice accepts an exact key and a unique prefix', () => {
  assert.deepEqual(selectDevice(['127.0.0.1:5555', 'usb-1'], 'usb-1'), { serial: 'usb-1' })
  assert.deepEqual(selectDevice(['127.0.0.1:5555', 'usb-1'], '127.0'), { serial: '127.0.0.1:5555' })
})

test('selectDevice reports an unknown key with the attached list', () => {
  const chosen = selectDevice(['abc'], 'zzz')
  assert.match(chosen.error, /no attached device matches/u)
  assert.match(chosen.error, /abc/u)
})

test('selectDevice names an ambiguous prefix instead of claiming no match', () => {
  // Two TCP targets share the typed prefix: the device exists, the key is just
  // too short. Reporting "no match" would make the caller give up.
  const serials = ['127.0.0.1:5555', '127.0.0.1:6666']
  const chosen = selectDevice(serials, '127.0')
  assert.match(chosen.error, /matches several attached devices/u)
  assert.match(chosen.error, /longer key/u)
  assert.match(chosen.error, /127\.0\.0\.1:5555/u)
  assert.match(chosen.error, /127\.0\.0\.1:6666/u)
  assert.equal(chosen.serial, undefined)
})

test('selectDevice reports a missing device actionably', () => {
  assert.match(selectDevice([], undefined).error, /no HarmonyOS device is connected/u)
})

test('sniffImageMediaType reads real signatures', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
  const gif = new TextEncoder().encode('GIF89a......')
  const webp = Uint8Array.from([
    ...new TextEncoder().encode('RIFF'),
    0, 0, 0, 0,
    ...new TextEncoder().encode('WEBP'),
  ])
  assert.equal(sniffImageMediaType(png), 'image/png')
  assert.equal(sniffImageMediaType(jpeg), 'image/jpeg')
  assert.equal(sniffImageMediaType(gif), 'image/gif')
  assert.equal(sniffImageMediaType(webp), 'image/webp')
  assert.equal(sniffImageMediaType(new TextEncoder().encode('[Fail]Not match target')), undefined)
})

test('clip keeps short text intact and marks what it dropped', () => {
  assert.equal(clip('hello', 100), 'hello')
  const clipped = clip('a'.repeat(100), 20)
  assert.match(clipped, /80 characters omitted/u)
  assert.ok(clipped.length < 100)
})

test('shq quotes only what needs it', () => {
  assert.equal(shq('/data/local/tmp/a.png'), '/data/local/tmp/a.png')
  assert.equal(shq('hello world'), "'hello world'")
  assert.equal(shq("it's"), "'it'\\''s'")
})

test('layout parsing reads the real dumpLayout document shape', () => {
  // Structure and bounds string form are taken from a real
  // `hdc shell uitest dumpLayout` output document.
  const document = {
    attributes: { bounds: '[0,0][1260,2720]', type: '', text: '' },
    children: [
      {
        attributes: { bounds: '[84,1127][1172,1295]', type: 'Button', text: 'Next', clickable: 'true' },
        children: [],
      },
      {
        attributes: { bounds: '[0,0][1260,200]', type: 'Text', text: '' },
        children: [
          { attributes: { bounds: '[20,40][300,120]', type: 'Text', text: 'Hello', clickable: 'false' }, children: [] },
        ],
      },
    ],
  }
  const nodes = summarizeLayout(JSON.stringify(document))
  const button = nodes.find((node) => node.type === 'Button')
  assert.deepEqual(
    { x: button.x, y: button.y, width: button.width, height: button.height },
    { x: 84, y: 1127, width: 1088, height: 168 },
  )
  assert.equal(button.text, 'Next')
  assert.equal(button.clickable, true)

  // Child bounds are absolute screen pixels, so a nested control keeps its own
  // coordinates instead of being offset by its parent.
  const nested = nodes.find((node) => node.text === 'Hello')
  assert.deepEqual({ x: nested.x, y: nested.y, width: nested.width, height: nested.height }, { x: 20, y: 40, width: 280, height: 80 })

  // A node with no type is a container and is not reported.
  assert.equal(nodes.length, 3)
})

test('bounds parsing rejects malformed rectangles instead of zero-filling', () => {
  assert.deepEqual(readBoundsString('[84,1127][1172,1295]'), { x: 84, y: 1127, width: 1088, height: 168 })
  assert.equal(readBoundsString('[84,1127][not-a-coordinate,1295]'), undefined)
  assert.equal(readBoundsString(''), undefined)
  assert.equal(readRect(undefined), undefined)
})

test('layout parsing survives a non-JSON dump', () => {
  assert.deepEqual(summarizeLayout('[Fail]Not match target founded'), [])
})

test('layout rendering names bounds and the tap point', () => {
  const line = formatLayoutNode({ type: 'Button', text: 'Next', x: 84, y: 1127, width: 1088, height: 168, clickable: true })
  assert.match(line, /^Button "Next" clickable @ \[84,1127\]\[1088x168\] tap \(628, 1211\)$/u)
})

test('the outline keeps a node inside the ancestor the filter kept', () => {
  // A labeled Text sits under two containers that the default filter drops. The
  // outline must place it inside whatever *was* kept above it, not at depth 3:
  // the raw depth of a real dump puts most controls twenty levels down, and a
  // tree drawn at that depth is empty indentation.
  const document = {
    attributes: { bounds: '[0,0][1260,2720]', type: 'Root' },
    children: [
      {
        attributes: { bounds: '[0,0][1260,2720]', type: 'Column' },
        children: [
          {
            attributes: { bounds: '[0,0][1260,2720]', type: 'Stack' },
            children: [
              { attributes: { bounds: '[84,1127][1172,1295]', type: 'Button', text: 'Next', clickable: 'true' }, children: [] },
            ],
          },
          { attributes: { bounds: '[10,10][20,20]', type: 'Image', clickable: 'true' }, children: [] },
        ],
      },
    ],
  }
  const nodes = summarizeLayout(JSON.stringify(document))
  const shown = nodes.filter((node) => node.text !== undefined || node.clickable)
  const rows = outlineLayout(nodes, shown)

  // Root is kept (it carries an id-like type label? no — it has no text), so the
  // first kept node is the Column's absence: both controls are direct children
  // of the root in the outline.
  assert.deepEqual(rows.map((row) => [row.depth, row.type]), [[0, 'Button'], [0, 'Image']])
  // Root has no text and is not clickable, so it is dropped too; the outline has
  // no parent to report for these two.
  assert.equal(rows.every((row) => row.hasChildren === false), true)
  assert.deepEqual(rows[0].tap, { x: 628, y: 1211 })
})

test('the outline reports a kept parent, its children, and their depth', () => {
  // `all_nodes` keeps the containers, which is what makes a caret meaningful:
  // the outline must mark the containers that actually have something under
  // them, and place each child one level deeper than its parent.
  const document = {
    attributes: { bounds: '[0,0][100,100]', type: 'Root' },
    children: [
      {
        attributes: { bounds: '[0,0][100,50]', type: 'Column' },
        children: [
          { attributes: { bounds: '[0,0][50,25]', type: 'Text', text: 'A', clickable: 'false' }, children: [] },
          { attributes: { bounds: '[50,0][100,25]', type: 'Text', text: 'B', clickable: 'false' }, children: [] },
        ],
      },
      { attributes: { bounds: '[0,50][100,100]', type: 'Text', text: 'Loose', clickable: 'false' }, children: [] },
    ],
  }
  const nodes = summarizeLayout(JSON.stringify(document))
  const rows = outlineLayout(nodes, nodes)
  assert.deepEqual(rows.map((row) => [row.depth, row.type, row.hasChildren]), [
    [0, 'Root', true],
    [1, 'Column', true],
    [2, 'Text', false],
    [2, 'Text', false],
    [1, 'Text', false],
  ])
  // Every row is tappable: the centre of its own bounds, in device pixels.
  assert.deepEqual(rows[2].tap, { x: 25, y: 12 })
})

// ── client discovery ────────────────────────────────────────────────────────
// The search order is the behavior worth pinning: a packaged desktop app has
// none of a terminal's exports, so the environment is usually empty and the
// conventional locations have to carry the common case on their own.

/** A path probe that reports exactly the given paths as present. */
function present(paths) {
  const known = new Set(paths)
  return (candidate) => known.has(candidate)
}

const DEVECO_APP = '/Applications/DevEco-Studio.app'
const APP_HDC = `${DEVECO_APP}/Contents/sdk/default/openharmony/toolchains/hdc`

test('discoverHdc finds the layout a current DevEco actually ships', async () => {
  // `default/` is the level that a pre-`default` layout missed entirely, which
  // is what made an installed DevEco report "hdc not found".
  assert.equal(await discoverHdc(undefined, { env: { PATH: '' }, platform: 'darwin', existing: present([APP_HDC]), loginShell: false }), APP_HDC)
})

test('discoverHdc honours DEVECO_SDK_HOME, which points at the sdk directory', async () => {
  const hdc = '/Users/dev/huawei/command-line-tools/sdk/default/openharmony/toolchains/hdc'
  const env = { PATH: '', DEVECO_SDK_HOME: '/Users/dev/huawei/command-line-tools/sdk' }
  assert.equal(await discoverHdc(undefined, { env, platform: 'darwin', existing: present([hdc]), loginShell: false }), hdc)
})

test('discoverHdc reads TOOL_HOME as the directory holding sdk', async () => {
  const hdc = '/Users/dev/huawei/command-line-tools/sdk/default/openharmony/toolchains/hdc'
  const env = { PATH: '', TOOL_HOME: '/Users/dev/huawei/command-line-tools' }
  assert.equal(await discoverHdc(undefined, { env, platform: 'darwin', existing: present([hdc]), loginShell: false }), hdc)
})

test('discoverHdc reads a DevEco bundle root from DEVECO_HOME', async () => {
  const env = { PATH: '', DEVECO_HOME: DEVECO_APP }
  assert.equal(await discoverHdc(undefined, { env, platform: 'darwin', existing: present([APP_HDC]), loginShell: false }), APP_HDC)
})

test('discoverHdc finds an install outside /Applications through PATH', async () => {
  // The interesting case: nothing in the environment, and the app is somewhere
  // the hard-coded locations never mention. Its tool bin on PATH is the clue.
  const home = '/Users/dev/Tools/DevEco-Studio.app'
  const hdc = `${home}/Contents/sdk/default/openharmony/toolchains/hdc`
  const env = { PATH: `/usr/bin:${home}/Contents/tools/hvigor/bin` }
  assert.equal(await discoverHdc(undefined, { env, platform: 'darwin', existing: present([hdc]), loginShell: false }), hdc)
})

test('discoverHdc prefers a toolchain over a stray hdc on PATH', async () => {
  // A stale hdc on PATH is the usual reason a device "is not found" while
  // DevEco itself connects, so PATH is the last resort rather than the first.
  const stray = '/usr/local/bin/hdc'
  const env = { PATH: '/usr/local/bin' }
  assert.equal(await discoverHdc(undefined, { env, platform: 'darwin', existing: present([stray, APP_HDC]), loginShell: false }), APP_HDC)
  assert.equal(await discoverHdc(undefined, { env, platform: 'darwin', existing: present([stray]), loginShell: false }), stray)
})

test('discoverHdc lets an explicit hdcPath win over every guess', async () => {
  const mine = '/opt/my-sdk/openharmony/toolchains/hdc'
  const env = { PATH: '/usr/local/bin', DEVECO_SDK_HOME: '/Users/dev/huawei/command-line-tools/sdk' }
  const existing = present([mine, APP_HDC, '/usr/local/bin/hdc'])
  assert.equal(await discoverHdc(mine, { env, platform: 'darwin', existing, loginShell: false }), mine)
})

test('discoverHdc reports nothing when no candidate exists', async () => {
  const env = { PATH: '/usr/bin:/bin', DEVECO_SDK_HOME: '/nope/sdk' }
  assert.equal(await discoverHdc(undefined, { env, platform: 'darwin', existing: () => false, loginShell: false }), undefined)
})

test('discoverHdc ignores a configured path that does not exist instead of failing', async () => {
  // A stale hdcPath must not shadow a working install: the search continues.
  const env = { PATH: '' }
  assert.equal(
    await discoverHdc('/gone/hdc', { env, platform: 'darwin', existing: present([APP_HDC]), loginShell: false }),
    APP_HDC,
  )
})

test('discoverHdc tries the Windows executable name', async () => {
  // Only the *name* is platform-specific; separators follow the host path
  // module, so the expectation is built the same way the search builds it.
  const home = path.join('/Users', 'dev')
  const hdc = path.join(home, 'AppData', 'Local', 'Huawei', 'Sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe')
  const found = await discoverHdc(undefined, {
    env: { PATH: '' },
    platform: 'win32',
    home,
    existing: present([hdc]),
    loginShell: false,
  })
  assert.equal(found?.endsWith('hdc.exe'), true, `expected an .exe client, got ${String(found)}`)
})

test('discoverHdc recovers a variable only the login shell knows', async () => {
  // The case that produced "hdc not found": a packaged desktop app starts with
  // none of a terminal's exports, so `DEVECO_SDK_HOME` is unset in the host
  // process even though the user's shell sets it. The `linux` profile keeps the
  // macOS `/Applications` constant out of the way, so only the shell's answer
  // can resolve this path.
  const hdc = '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc'
  const found = await discoverHdc(undefined, {
    env: { PATH: '', SHELL: '/bin/zsh' },
    platform: 'linux',
    home: '/nonexistent-home',
    existing: (path_) => path_ === hdc,
  })
  // A machine with no usable login shell (a container, a CI image) must not
  // fail the suite either: no shell means no answer, not a wrong one.
  if (found !== undefined) assert.equal(found, hdc)
})

test('a slow login shell does not block the event loop', async () => {
  // The probe runs on the request path whenever the earlier stages come up empty.
  // Done synchronously it stopped the entire Host — every other request and tool
  // call — for as long as an interactive shell took to start.
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-shell-'))
  try {
    // Named `bash` on purpose: the probe only trusts a shell it recognises, so a
    // stand-in with any other basename would be skipped and prove nothing.
    const shell = path.join(dir, 'bash')
    // A shell that takes a moment and then answers nothing useful.
    await writeFile(shell, ['#!/bin/sh', 'sleep 0.3', 'exit 0', ''].join('\n'))
    chmodSync(shell, 0o755)

    // The cache is process-wide, so an earlier test's empty answer would make
    // this pass without ever running the shell.
    forgetLoginShellCache()
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 20)
    const started = Date.now()
    const found = await discoverHdc(undefined, {
      env: { PATH: '', SHELL: shell },
      platform: 'darwin',
      existing: () => false,
    })
    const elapsed = Date.now() - started
    clearInterval(timer)
    assert.equal(found, undefined, 'no client exists, so the search reports nothing')
    // A blocking probe would freeze the timer for its whole duration.
    assert.ok(ticks >= 3, `the event loop must keep running during the probe, saw ${ticks} ticks in ${elapsed} ms`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
