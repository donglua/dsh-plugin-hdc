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
import test from 'node:test'
import {
  clip,
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
