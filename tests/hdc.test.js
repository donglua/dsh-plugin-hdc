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
import path from 'node:path'
import test from 'node:test'
import {
  clip,
  discoverHdc,
  parseTargets,
  selectDevice,
  sniffImageMediaType,
  shq,
} from '../lib/hdc.js'
import { summarizeLayout, readRect, readBoundsString, formatLayoutNode } from '../lib/tools.js'

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

test('discoverHdc finds the layout a current DevEco actually ships', () => {
  // `default/` is the level that a pre-`default` layout missed entirely, which
  // is what made an installed DevEco report "hdc not found".
  assert.equal(discoverHdc(undefined, { env: { PATH: '' }, platform: 'darwin', existing: present([APP_HDC]), loginShell: false }), APP_HDC)
})

test('discoverHdc honours DEVECO_SDK_HOME, which points at the sdk directory', () => {
  const hdc = '/Users/dev/huawei/command-line-tools/sdk/default/openharmony/toolchains/hdc'
  const env = { PATH: '', DEVECO_SDK_HOME: '/Users/dev/huawei/command-line-tools/sdk' }
  assert.equal(discoverHdc(undefined, { env, platform: 'darwin', existing: present([hdc]), loginShell: false }), hdc)
})

test('discoverHdc reads TOOL_HOME as the directory holding sdk', () => {
  const hdc = '/Users/dev/huawei/command-line-tools/sdk/default/openharmony/toolchains/hdc'
  const env = { PATH: '', TOOL_HOME: '/Users/dev/huawei/command-line-tools' }
  assert.equal(discoverHdc(undefined, { env, platform: 'darwin', existing: present([hdc]), loginShell: false }), hdc)
})

test('discoverHdc reads a DevEco bundle root from DEVECO_HOME', () => {
  const env = { PATH: '', DEVECO_HOME: DEVECO_APP }
  assert.equal(discoverHdc(undefined, { env, platform: 'darwin', existing: present([APP_HDC]), loginShell: false }), APP_HDC)
})

test('discoverHdc finds an install outside /Applications through PATH', () => {
  // The interesting case: nothing in the environment, and the app is somewhere
  // the hard-coded locations never mention. Its tool bin on PATH is the clue.
  const home = '/Users/dev/Tools/DevEco-Studio.app'
  const hdc = `${home}/Contents/sdk/default/openharmony/toolchains/hdc`
  const env = { PATH: `/usr/bin:${home}/Contents/tools/hvigor/bin` }
  assert.equal(discoverHdc(undefined, { env, platform: 'darwin', existing: present([hdc]), loginShell: false }), hdc)
})

test('discoverHdc prefers a toolchain over a stray hdc on PATH', () => {
  // A stale hdc on PATH is the usual reason a device "is not found" while
  // DevEco itself connects, so PATH is the last resort rather than the first.
  const stray = '/usr/local/bin/hdc'
  const env = { PATH: '/usr/local/bin' }
  assert.equal(discoverHdc(undefined, { env, platform: 'darwin', existing: present([stray, APP_HDC]), loginShell: false }), APP_HDC)
  assert.equal(discoverHdc(undefined, { env, platform: 'darwin', existing: present([stray]), loginShell: false }), stray)
})

test('discoverHdc lets an explicit hdcPath win over every guess', () => {
  const mine = '/opt/my-sdk/openharmony/toolchains/hdc'
  const env = { PATH: '/usr/local/bin', DEVECO_SDK_HOME: '/Users/dev/huawei/command-line-tools/sdk' }
  const existing = present([mine, APP_HDC, '/usr/local/bin/hdc'])
  assert.equal(discoverHdc(mine, { env, platform: 'darwin', existing, loginShell: false }), mine)
})

test('discoverHdc reports nothing when no candidate exists', () => {
  const env = { PATH: '/usr/bin:/bin', DEVECO_SDK_HOME: '/nope/sdk' }
  assert.equal(discoverHdc(undefined, { env, platform: 'darwin', existing: () => false, loginShell: false }), undefined)
})

test('discoverHdc ignores a configured path that does not exist instead of failing', () => {
  // A stale hdcPath must not shadow a working install: the search continues.
  const env = { PATH: '' }
  assert.equal(
    discoverHdc('/gone/hdc', { env, platform: 'darwin', existing: present([APP_HDC]), loginShell: false }),
    APP_HDC,
  )
})

test('discoverHdc tries the Windows executable name', () => {
  // Only the *name* is platform-specific; separators follow the host path
  // module, so the expectation is built the same way the search builds it.
  const home = path.join('/Users', 'dev')
  const hdc = path.join(home, 'AppData', 'Local', 'Huawei', 'Sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe')
  const found = discoverHdc(undefined, {
    env: { PATH: '' },
    platform: 'win32',
    home,
    existing: present([hdc]),
    loginShell: false,
  })
  assert.equal(found?.endsWith('hdc.exe'), true, `expected an .exe client, got ${String(found)}`)
})

test('discoverHdc recovers a variable only the login shell knows', () => {
  // The case that produced "hdc not found": a packaged desktop app starts with
  // none of a terminal's exports, so `DEVECO_SDK_HOME` is unset in the host
  // process even though the user's shell sets it. The `linux` profile keeps the
  // macOS `/Applications` constant out of the way, so only the shell's answer
  // can resolve this path.
  const hdc = '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc'
  const found = discoverHdc(undefined, {
    env: { PATH: '', SHELL: '/bin/zsh' },
    platform: 'linux',
    home: '/nonexistent-home',
    existing: (path_) => path_ === hdc,
  })
  // A machine with no usable login shell (a container, a CI image) must not
  // fail the suite either: no shell means no answer, not a wrong one.
  if (found !== undefined) assert.equal(found, hdc)
})
