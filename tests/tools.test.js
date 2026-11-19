/**
 * Offline checks for the registered tool definitions.
 *
 * A stub context records every registration, so the whole tool family can be
 * exercised without a device, and each definition is validated against DSH's
 * own schema assertion and executed through a fake `exec`.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTools } from '../lib/tools.js'

/** Collect registrations from a minimal stand-in for `ctx`. */
function harness(services = {}) {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(registered.has(definition.name), false, `duplicate tool ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    get: (name) => services[name],
  }
  registerTools(ctx, {})
  return registered
}

/** A tool run context with no attached device. */
function exec() {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: '/tmp' } } },
  }
}

test('every documented tool is registered exactly once', () => {
  const tools = harness()
  assert.deepEqual([...tools.keys()].sort(), [
    'hdc_app',
    'hdc_devices',
    'hdc_file',
    'hdc_input',
    'hdc_log',
    'hdc_record',
    'hdc_screenshot',
    'hdc_ui_tree',
  ])
})

test('each definition is a complete tool shape', () => {
  for (const [name, definition] of harness()) {
    assert.equal(definition.name, name)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20, `${name} needs a real description`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output.render, 'function', `${name} needs a renderer`)
    assert.equal(typeof definition.execute, 'function', `${name} needs execute`)
  }
})

test('parameters declare required fields as an array, not a boolean', () => {
  for (const [name, definition] of harness()) {
    const { parameters } = definition
    if (parameters.required !== undefined) {
      assert.ok(Array.isArray(parameters.required), `${name} required must be an array`)
      for (const field of parameters.required) {
        assert.ok(Object.hasOwn(parameters.properties, field), `${name}.${field} must be declared`)
      }
    }
    for (const [field, schema] of Object.entries(parameters.properties)) {
      assert.notEqual(schema.required, true, `${name}.${field} must not use the DSL required flag`)
    }
  }
})

test('every output schema field a renderer reads is declared required', () => {
  // Renderers read these fields unconditionally, so a missing declaration would
  // surface as an undefined field in the model-facing text.
  const expectations = {
    hdc_devices: ['hdcPath', 'devices'],
    hdc_screenshot: ['device', 'image'],
    hdc_input: ['device', 'command'],
    hdc_ui_tree: ['device', 'content', 'truncated'],
    hdc_app: ['device', 'action', 'output'],
    hdc_log: ['device', 'scanned', 'matches', 'content'],
    hdc_file: ['device', 'action', 'output'],
    hdc_record: ['device', 'savedPath', 'seconds', 'bytes'],
  }
  const tools = harness()
  for (const [name, fields] of Object.entries(expectations)) {
    const schema = tools.get(name).output.schema
    assert.deepEqual(schema.required, fields, `${name} required fields`)
    assert.equal(schema.additionalProperties, false)
  }
})

test('the screenshot renderer emits text followed by an image block', () => {
  const definition = harness().get('hdc_screenshot')
  const value = {
    device: '127.0.0.1:5555',
    image: {
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: 2048,
      width: 1260,
      height: 2720,
      originalDimensions: { width: 2520, height: 5440 },
    },
  }
  const blocks = definition.output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /1260x2720/u)
  assert.match(blocks[0].text, /downscaled from 2520x5440/u)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att-1')
  assert.equal(blocks[1].attachment.mediaType, 'image/png')
  assert.deepEqual(blocks[1].attachment.originalDimensions, { width: 2520, height: 5440 })
})

test('the screenshot renderer omits the scale note when not downscaled', () => {
  const definition = harness().get('hdc_screenshot')
  const blocks = definition.output.render({}, {
    device: 'usb-1',
    image: { attachmentId: 'a', mediaType: 'image/png', bytes: 10, width: 100, height: 200 },
  })
  assert.equal(blocks[0].text.includes('downscaled'), false)
  assert.equal(Object.hasOwn(blocks[1].attachment, 'originalDimensions'), false)
})

test('the device list renderer explains an empty result', () => {
  const definition = harness().get('hdc_devices')
  const [block] = definition.output.render({}, { hdcPath: '/x/hdc', devices: [] })
  assert.match(block.text, /No HarmonyOS device is attached/u)
  const [listed] = definition.output.render({}, { hdcPath: '/x/hdc', devices: ['a', 'b'] })
  assert.match(listed.text, /HarmonyOS devices \(2\)/u)
  assert.match(listed.text, /- a\n- b/u)
})

test('input rejects an action whose coordinates are missing', async () => {
  const definition = harness().get('hdc_input')
  await assert.rejects(
    () => definition.execute({ action: 'click', x: 10 }, exec()),
    /click requires y/u,
  )
})

test('text input requires the text argument', async () => {
  const definition = harness().get('hdc_input')
  await assert.rejects(() => definition.execute({ action: 'text' }, exec()), /text requires text/u)
})

test('file transfer requires both paths before touching the device', async () => {
  const definition = harness().get('hdc_file')
  await assert.rejects(
    () => definition.execute({ action: 'recv', remote: '/a' }, exec()),
    /recv requires local/u,
  )
})
