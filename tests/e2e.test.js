/**
 * End-to-end checks against a fake `hdc`, covering the paths that a device would
 * otherwise be needed to reach: device selection, screenshot capture through the
 * attachment service, input commands, log filtering, and failure reporting.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { registerTools } from '../lib/tools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeHdc = path.join(here, 'fake-hdc.sh')
chmodSync(fakeHdc, 0o755)

/**
 * Build a plugin harness over the fake client.
 *
 * @param options.mode - `device` or `empty`, forwarded to the fake.
 * @param options.services - extra services the tools look up.
 */
async function harness({ mode = 'device', services = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-hdc-e2e-'))
  process.env.DSH_HDC_FAKE_DIR = dir
  process.env.DSH_HDC_FAKE_MODE = mode
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    get: (name) => services[name],
  }
  registerTools(ctx, { hdcPath: fakeHdc, downloadDir: dir })
  return { tools: registered, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A tool run context. */
function exec() {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd: '/tmp' } } } }
}

/** An attachment service stand-in that records what it was given. */
function attachmentService() {
  const saved = []
  return {
    saved,
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: 'att-fake',
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 2,
        height: 2,
        ...input.name === undefined ? {} : { name: input.name },
      }
    },
  }
}

test('devices are listed through the client', async () => {
  const h = await harness()
  try {
    const value = await h.tools.get('hdc_devices').execute({}, exec())
    assert.deepEqual(value.devices, ['FakePhone123'])
    assert.equal(value.hdcPath, fakeHdc)
  } finally {
    await h.cleanup()
  }
})

test('an empty device list is reported as empty', async () => {
  const h = await harness({ mode: 'empty' })
  try {
    const value = await h.tools.get('hdc_devices').execute({}, exec())
    assert.deepEqual(value.devices, [])
  } finally {
    await h.cleanup()
  }
})

test('a device call with nothing attached explains the fix', async () => {
  const h = await harness({ mode: 'empty' })
  try {
    await assert.rejects(
      () => h.tools.get('hdc_input').execute({ action: 'click', x: 1, y: 2 }, exec()),
      /no HarmonyOS device is connected/u,
    )
  } finally {
    await h.cleanup()
  }
})

test('a screenshot becomes an image attachment and an image block', async () => {
  const attachments = attachmentService()
  const h = await harness({ services: { attachments } })
  try {
    const tool = h.tools.get('hdc_screenshot')
    const savedPath = path.join(h.dir, 'shot.png')
    const value = await tool.execute({ save_path: 'shot.png' }, exec())

    assert.equal(value.device, 'FakePhone123')
    assert.equal(value.image.attachmentId, 'att-fake')
    assert.equal(value.image.mediaType, 'image/png')
    assert.equal(attachments.saved.length, 1, 'the image must be persisted before returning')

    // The saved copy is the same PNG the attachment service received.
    const onDisk = await readFile(savedPath)
    assert.deepEqual([...onDisk], [...attachments.saved[0].data])
    assert.deepEqual([...onDisk.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const blocks = tool.output.render({}, value)
    assert.equal(blocks[1].type, 'image')
    assert.equal(blocks[1].attachment.attachmentId, 'att-fake')
  } finally {
    await h.cleanup()
  }
})

test('the hierarchy keeps an unlabeled clickable control by default', async () => {
  const h = await harness()
  try {
    const tool = h.tools.get('hdc_ui_tree')
    const value = await tool.execute({}, exec())

    // The labeled button is reported, as always.
    assert.match(value.content, /Button "Next" clickable/u)
    // The icon button has no text, id, or description. It is still a tap target,
    // so the default view must not hide it; only its position identifies it.
    assert.match(value.content, /Image clickable @ \[1100,40\]\[100x100\] tap \(1150, 90\)/u)
    // A node with no type is a container and stays out of the default view.
    assert.equal(value.content.includes('Column'), false)

    // all_nodes still reveals everything, containers included.
    const all = await tool.execute({ all_nodes: true }, exec())
    assert.match(all.content, /Column/u)
  } finally {
    await h.cleanup()
  }
})

test('a screenshot fails clearly when no attachment service is mounted', async () => {
  const h = await harness()
  try {
    await assert.rejects(
      () => h.tools.get('hdc_screenshot').execute({}, exec()),
      /no attachment service is mounted/u,
    )
  } finally {
    await h.cleanup()
  }
})

test('input builds the documented uitest commands', async () => {
  const h = await harness()
  try {
    const tool = h.tools.get('hdc_input')
    assert.equal((await tool.execute({ action: 'click', x: 10, y: 20 }, exec())).command, 'click 10 20')
    assert.equal(
      (await tool.execute({ action: 'swipe', x: 1, y: 2, to_x: 3, to_y: 4, duration_ms: 800 }, exec())).command,
      'swipe 1 2 3 4 800',
    )
    assert.equal((await tool.execute({ action: 'key', key: 'Back' }, exec())).command, 'keyEvent Back')
    assert.equal((await tool.execute({ action: 'text', text: 'hello world' }, exec())).command, "text 'hello world'")
  } finally {
    await h.cleanup()
  }
})

test('log filtering keeps only crash markers', async () => {
  const h = await harness()
  try {
    const value = await h.tools.get('hdc_log').execute({ crash: true }, exec())
    assert.equal(value.matches, 1)
    assert.match(value.content, /CppCrash/u)
    assert.equal(value.content.includes('started ok'), false)
  } finally {
    await h.cleanup()
  }
})

test('log keyword filtering is case-insensitive', async () => {
  const h = await harness()
  try {
    const value = await h.tools.get('hdc_log').execute({ keyword: 'STILL FINE' }, exec())
    assert.equal(value.matches, 1)
    assert.match(value.content, /still fine/u)
  } finally {
    await h.cleanup()
  }
})

test('log reading bounds the tail with the flag the client actually accepts', async () => {
  const h = await harness()
  try {
    // The fake rejects `-x` with `-z` (CODE: -31) and rejects `-n` outright, as
    // the real client does, so a regression to either form fails this call.
    const value = await h.tools.get('hdc_log').execute({ lines: 250 }, exec())
    // Four printed lines, plus the empty segment a trailing newline leaves.
    assert.equal(value.scanned, 5)
    assert.match(value.content, /CppCrash/u)
  } finally {
    await h.cleanup()
  }
})

test('crash filtering ignores a subsystem name that merely contains fault', async () => {
  const h = await harness()
  try {
    const value = await h.tools.get('hdc_log').execute({ crash: true }, exec())
    // "FaultLeakDetectorManager" appears in ordinary lifecycle lines; matching a
    // bare "fault" would report those as crashes.
    assert.equal(value.content.includes('FaultLeakDetectorManager'), false)
    assert.equal(value.matches, 1, 'only the CppCrash line qualifies')
  } finally {
    await h.cleanup()
  }
})

test('a file is received into the download directory', async () => {
  const h = await harness()
  try {
    const value = await h.tools.get('hdc_file').execute(
      { action: 'recv', remote: '/data/local/tmp/layout.json', local: 'got.json' },
      exec(),
    )
    assert.equal(value.action, 'recv')
    assert.equal(value.localPath, path.join(h.dir, 'got.json'))
    const body = await readFile(value.localPath, 'utf8')
    assert.match(body, /"type":"Column"/u, 'the received file keeps its exact bytes')
  } finally {
    await h.cleanup()
  }
})

test('install refuses a missing package before contacting the device', async () => {
  const h = await harness()
  try {
    await assert.rejects(
      () => h.tools.get('hdc_app').execute({ action: 'install', package: 'missing.hap' }, exec()),
      /no such package file/u,
    )
  } finally {
    await h.cleanup()
  }
})

test('app actions run through the client', async () => {
  const h = await harness()
  try {
    const tool = h.tools.get('hdc_app')
    assert.match((await tool.execute({ action: 'start', bundle: 'com.example.app' }, exec())).output, /aa ok/u)
    assert.match((await tool.execute({ action: 'list' }, exec())).output, /com\.example\.app/u)
  } finally {
    await h.cleanup()
  }
})
