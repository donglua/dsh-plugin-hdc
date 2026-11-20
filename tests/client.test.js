/**
 * Render the panel offline, against a stub React.
 *
 * The client half is a hand-written module-loader bundle, so nothing type-checks
 * it: a reference to a state variable that no longer exists, or a `t()` key
 * missing from one dictionary, would only show up as a blank page in the
 * browser. This drives the real component through a minimal React stand-in and
 * walks the element tree it returns.
 *
 * The stand-in keeps hook state in order between renders and can flush the
 * recorded effects, so a scenario can be followed past its first paint — load
 * the device list, then assert the picture and its controls are what the stream
 * design says they should be.
 *
 *   node --test tests/
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'lib', 'client.js')

/**
 * A React stand-in with ordered hook slots.
 *
 * State survives across renders, which is what makes a multi-step scenario
 * meaningful: render, flush the effects, render again against the new state.
 */
function createReact() {
  const slots = []
  let cursor = 0
  let effects = []
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== false && child !== undefined),
      }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      }]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(fn) {
      cursor += 1
      return fn
    },
    useMemo(fn) {
      cursor += 1
      return fn()
    },
    useEffect(fn) {
      cursor += 1
      effects.push(fn)
    },
  }
  const cleanups = []
  return {
    React,
    /**
     * Render once and then run that render's effects, the way a mount does.
     *
     * The hook cursor resets but the state slots keep their values, so a test
     * can render, await the request an effect started, and render again against
     * the state it wrote.
     */
    render(component, props) {
      cursor = 0
      effects = []
      const tree = component(props)
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      return { tree, effects }
    },
    /** Run every cleanup an earlier render returned. */
    unmount() {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

/**
 * Load the client bundle and take the panel component it registers.
 *
 * The bundle calls `window.__ModuleLoader__.load({factory})`; the loader stub
 * runs the factory and then `apply` against a context that records what was
 * registered, so the component can be rendered without a browser.
 */
function loadClient(fetchImpl) {
  const source = readFileSync(clientPath, 'utf8')
  const registered = { panels: [], pages: [] }
  const react = createReact()
  const loader = {
    load(entry) {
      const exported = entry.factory((name) => {
        if (name === 'react') return react.React
        throw new Error(`unexpected require: ${name}`)
      })
      const ctx = {
        effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
        locale: {
          register: () => () => {},
          bind: () => (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
        },
        slots: {
          inject: (_name, fn) => fn(),
          register: (options, component) => {
            const target = options.name === 'main' ? registered.pages : registered.panels
            target.push({ options, component })
            return () => {}
          },
        },
      }
      exported.apply(ctx)
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    console,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  }
  vm.runInNewContext(source, sandbox, { filename: clientPath })
  return { ...registered, react }
}

/** Every string in a rendered tree, skipping stylesheet text. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (node.type === 'style') return out
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

/** Every element carrying one class, in document order. */
function elementsOf(node, className, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, className, out)
    return out
  }
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/u).includes(className)) out.push(node)
  for (const child of node.children ?? []) elementsOf(child, className, out)
  return out
}

/** A fetch stand-in answering the panel's own routes with the given bodies. */
function fetchWith(routes) {
  return async (url, init = {}) => {
    const pathname = String(url).split('?')[0]
    const handler = routes[pathname]
    if (handler === undefined) {
      return {
        ok: false,
        status: 404,
        clone() { return { json: async () => ({ error: { code: 'HDC_UNKNOWN_ROUTE', message: `no route ${pathname}` } }) } },
      }
    }
    const body = await handler(init)
    return { ok: true, status: 200, clone() { return { json: async () => body } } }
  }
}

test('the bundle registers a sidebar entry and the page it opens', () => {
  const { panels, pages } = loadClient(fetchWith({}))
  assert.equal(panels.length, 1)
  assert.equal(pages.length, 1)
  assert.equal(panels[0].options.id, 'hdc-panel')
  assert.equal(pages[0].options.key, 'hdc-panel')
  // Id and key must agree, or the layout never switches to the page.
  assert.equal(panels[0].options.id, pages[0].options.key)
})

test('with no device attached the panel explains how to connect one', async () => {
  const { pages, react } = loadClient(fetchWith({
    '/hdc/devices': async () => ({ hdcPath: '/x/hdc', devices: [] }),
  }))
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  const { tree } = react.render(page, { t: (key) => key })
  assert.match(textOf(tree).join(' '), /empty\.title/u)
})

test('a found device puts a live MJPEG stream in the stage, not a blob URL', async () => {
  const { pages, react } = loadClient(fetchWith({
    '/hdc/devices': async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }),
  }))
  const page = pages[0].component

  // Paint once, then let the device-list effect settle, then paint the state it
  // produced — the same order a browser goes through.
  react.render(page, { t: (key) => key })
  await settle()
  const { tree } = react.render(page, { t: (key) => key })

  const picture = elementsOf(tree, 'hdci-shot')
  assert.equal(picture.length, 1, 'exactly one live picture')
  assert.equal(picture[0].type, 'img')
  assert.equal(picture[0].props.src, '/hdc/stream?device=phone-1')
  assert.equal(String(picture[0].props.src).startsWith('blob:'), false)

  // The picture is tappable: the press handler is the device-input path. It is
  // `pointerdown`, not `click`: a click waits for the button to come back up, so
  // a press that drifts a few pixels is cancelled as a drag and the tap is lost.
  assert.equal(typeof picture[0].props.onPointerDown, 'function')
  assert.equal(picture[0].props.onClick, undefined, 'a tap must not wait for the button to come back up')

  // Capture and recording are reachable, and the record length is a choice.
  const labels = textOf(tree).join(' ')
  assert.match(labels, /shot\.snapshot/u)
  assert.match(labels, /shot\.record/u)
  const selects = elementsOf(tree, 'hdci-select-narrow')
  assert.equal(selects.length, 1)
  assert.equal(selects[0].props.value, '10', 'a ten-second recording is the default')
})

test('every t() key the panel uses exists in both dictionaries', () => {
  const source = readFileSync(clientPath, 'utf8')
  const used = new Set()
  for (const match of source.matchAll(/\bt\('([a-z][\w.]*)'/gu)) used.add(match[1])
  const zh = dictionaryOf(source, 'const zh = {')
  const en = dictionaryOf(source, 'const en = {')
  for (const key of used) {
    // The sidebar label is registered through the locale service, separately.
    if (key === 'panel') continue
    assert.ok(zh.has(key), `zh is missing ${key}`)
    assert.ok(en.has(key), `en is missing ${key}`)
  }
  assert.deepEqual([...zh].sort(), [...en].sort(), 'both languages must carry the same keys')
})

/** Let every pending microtask and zero-delay timer run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** The key set of one inline dictionary literal. */
function dictionaryOf(source, header) {
  const start = source.indexOf(header)
  assert.ok(start >= 0, `no ${header}`)
  const end = source.indexOf('\n    }', start)
  const body = source.slice(start, end)
  const keys = new Set()
  for (const match of body.matchAll(/^\s*'([\w.]+)':/gmu)) keys.add(match[1])
  for (const match of body.matchAll(/^\s{6}([a-zA-Z]\w*):/gmu)) keys.add(match[1])
  return keys
}

// ── the picture's box, and what a tap means ────────────────────────────────
// Two regressions are pinned here, both from the live-picture rewrite:
// the image grew past its stage and got clipped, and the panel dropped a tap
// while another was in flight. The first is CSS-shaped, the second is about
// intent, and neither is visible without a browser — so they are asserted on
// the source and on the component's behaviour instead.

/** The panel's stylesheet text, extracted from the bundle. */
function panelCss() {
  const source = readFileSync(clientPath, 'utf8')
  const match = /const STYLE_TEXT = `([\s\S]*?)`/u.exec(source)
  assert.ok(match !== null, 'the panel must ship a stylesheet')
  return match[1]
}

test('the picture is a direct child of the stage, so it cannot outgrow it', () => {
  // `max-height: 100%` resolves against the stage only when the image is the
  // stage's own child. A flex wrapper with `flex: 1` gave the image a taller
  // box to fill, so it rendered 2387 px tall inside a 700 px stage: clipped on
  // screen, and — because the tap math divides by the image's box — it sent
  // taps up to 952 device pixels away from where the user clicked.
  const source = readFileSync(clientPath, 'utf8')
  assert.equal(/className: 'hdci-shotbox'/u.test(source), false, 'no wrapper between the stage and the picture')
  assert.match(source, /'hdci-stage' \}, renderStage\(\)/u, 'the stage renders the picture itself')
})

test('no rule gives the picture a minimum size that a stage cannot honour', () => {
  // A `min-width`/`min-height` on the image wins over `max-height: 100%`, which
  // is the other way the picture escaped its stage.
  const css = panelCss()
  const shotRules = css.split('\n').filter((line) => /\.hdci-shot[^-]/u.test(line))
  assert.ok(shotRules.length > 0, 'the picture must be styled')
  for (const rule of shotRules) {
    assert.equal(/min-width|min-height/u.test(rule), false, `a minimum size breaks the fit: ${rule}`)
  }
})

test('the picture keeps the aspect ratio it is drawn at', () => {
  // The tap math assumes the drawn box and the image share a ratio; a rule that
  // set an explicit width or height would break that silently.
  const css = panelCss()
  const shot = css.split('\n').find((line) => /^\.hdci-shot\{/u.test(line))
  assert.ok(shot !== undefined, 'the picture rule must exist')
  assert.match(shot, /width:auto/u)
  assert.match(shot, /height:auto/u)
  assert.match(shot, /max-width:100%/u)
  assert.match(shot, /max-height:100%/u)
})

test('a tap is queued, never dropped while another is in flight', () => {
  // One tap costs the device ~0.4 s. Refusing a second tap during that window
  // is what made a double tap or a fast second tap vanish, which reads as the
  // picture not following the finger.
  const source = readFileSync(clientPath, 'utf8')
  // The click handler must not bail out on a busy flag.
  const handler = source.slice(source.indexOf('function onShotClick'), source.indexOf('function pressKey'))
  assert.equal(/if \(device === null \|\| inputBusy\) return/u.test(handler), false, 'the click handler must not drop a tap')
  // Input must go through a queue that drains in order.
  assert.match(source, /const queueRef = useRef\(\{ device: null, items: \[\], running: false \}\)/u)
  assert.match(source, /queue\.items\.push\(\{ payload, done \}\)/u)
  assert.match(source, /const item = queue\.items\.shift\(\)/u)
})

test('controls stay usable during an in-flight input, because the queue orders them', () => {
  // Disabling Back/Home/Power for the length of an unrelated tap is the other
  // half of "not following the finger".
  const source = readFileSync(clientPath, 'utf8')
  for (const name of ['renderActions', 'renderTextRow']) {
    const body = source.slice(source.indexOf(`function ${name}(`), source.indexOf('\n      }', source.indexOf(`function ${name}(`)))
    assert.match(body, /const disabled = device === null/u, `${name} must only depend on a device being present`)
    assert.equal(/const disabled = device === null \|\| busy/u.test(body), false, `${name} must not gate on the input queue`)
  }
})

test('a queued tap belongs to the device that was showing when it was made', () => {
  // Switching device must not deliver the previous device's taps to the new one.
  const source = readFileSync(clientPath, 'utf8')
  assert.match(source, /if \(queue\.device !== device\) \{/u)
  assert.match(source, /queue\.items = \[\]/u)
})

test('a tap mark is placed in stage pixels, not picture percentages', () => {
  // The stage is the containing block for an absolutely positioned child, and
  // the picture is normally narrower than the stage (a tall phone screen in a
  // wide panel). A percentage of the *picture* therefore put the mark outside
  // the picture entirely — two of three marks landed on the panel background.
  const source = readFileSync(clientPath, 'utf8')
  const handler = source.slice(source.indexOf('function onShotPointerDown'), source.indexOf('function pressKey'))
  assert.match(handler, /image\.parentElement/u, 'the mark must be placed against the stage')
  assert.match(handler, /getBoundingClientRect\(\)/u)
  // The offsets are computed from the press position minus the stage origin.
  assert.match(handler, /event\.clientX - stageBox\.left/u)
  assert.match(handler, /event\.clientY - stageBox\.top/u)
  // The border is excluded, because an absolutely positioned child is laid out
  // against the padding box, not the border box. `clientLeft` is read instead of
  // `getComputedStyle`, which would force a style recalc on every tap.
  assert.match(handler, /stage\.clientLeft/u)
  assert.match(handler, /stage\.clientTop/u)
  // A *call* to getComputedStyle is what forces the recalc; the comment that
  // explains why it is avoided is not the thing under test.
  assert.equal(/getComputedStyle\(/u.test(handler), false, 'a tap must not force a style recalc')
  // No percentage-of-picture positioning, which is the form that broke.
  assert.equal(/left: `\$\{\(\(event\.clientX - box\.left\) \/ box\.width\) \* 100\}%`/u.test(handler), false)
})

test('a tap is mapped to the device pixel it landed in, and floored', () => {
  // `naturalWidth` is the capture's own pixel count and the Host captures at
  // device resolution, so the ratio is the exact display→device scale. Flooring
  // gives the index of the pixel the press landed in; rounding instead credits
  // the nearer pixel center, which biases every coordinate by up to half a pixel
  // and can reach a pixel past the far edge.
  const source = readFileSync(clientPath, 'utf8')
  const handler = source.slice(source.indexOf('function onShotPointerDown'), source.indexOf('function pressKey'))
  assert.match(handler, /Math\.floor\(\(\(event\.clientX - box\.left\) \/ box\.width\) \* width\)/u)
  assert.match(handler, /Math\.floor\(\(\(event\.clientY - box\.top\) \/ box\.height\) \* height\)/u)
  // Both axes are clamped inside the screen, so a press on the very border still
  // names a pixel that exists.
  assert.match(handler, /, 0, width - 1\)/u)
  assert.match(handler, /, 0, height - 1\)/u)
  // A secondary button (a pen's eraser, a middle click) is not a tap.
  assert.match(handler, /event\.button !== 0/u)
})

test('a burst of taps schedules one sweep timer, not one per tap', () => {
  // Each mark used to schedule its own timeout that rebuilt the whole array. At
  // ~5 fps the picture repaints anyway; a fast double tap should not add two
  // timers and two state updates on top of that.
  const source = readFileSync(clientPath, 'utf8')
  const handler = source.slice(source.indexOf('function onShotPointerDown'), source.indexOf('function pressKey'))
  assert.match(handler, /if \(markSweepRef\.current === null\)/u, 'the timer must only be scheduled when idle')
  assert.match(handler, /setTimeout\(sweepMarks, MARK_LIFETIME_MS\)/u)
  assert.match(source, /const markSweepRef = useRef\(null\)/u)
  // A single fixed-delay timer would strand a mark made just before it fired:
  // the cutoff would spare it and nothing would ever remove it again. The sweep
  // must re-arm for the oldest survivor, and must clear the ref when idle.
  const sweep = source.slice(source.indexOf('const sweepMarks = useCallback'), source.indexOf('function onShotPointerDown'))
  assert.match(sweep, /now - entry\.at < MARK_LIFETIME_MS/u, 'marks are pruned by age')
  assert.match(sweep, /oldest/u, 'it must re-arm against the oldest surviving mark')
  assert.match(sweep, /Math\.max\(1, /u, 'a zero delay must not be able to spin')
  assert.match(sweep, /markSweepRef\.current = null/u)
  // Unmounting must clear the timer: it holds a state setter.
  const cleanup = source.slice(source.indexOf('// Unmount: no timer or in-flight request survives this.'))
  assert.match(cleanup, /clearTimeout\(markSweepRef\.current\)/u)
})

test('the tap mark stays visible even without the host theme tokens', () => {
  // A theme token that is absent must not make the feedback invisible; the
  // mark is the only acknowledgement the panel gives for ~0.4 s.
  const css = panelCss()
  const rule = css.split('\n').find((line) => /^\.hdci-ripple\{/u.test(line))
  assert.ok(rule !== undefined, 'the mark must be styled')
  assert.match(rule, /var\(--dsw-alias-state-business-primary,/u, 'the token needs a literal fallback')
  assert.match(rule, /background:rgba\(/u, 'the fill must not depend on a token at all')
  assert.match(rule, /pointer-events:none/u, 'the mark must not swallow the next tap')
  // A reduced-motion preference must still show something.
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.hdci-ripple\{animation:none/u)
})
