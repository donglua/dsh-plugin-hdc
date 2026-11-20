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
 *
 * Two behaviours matter for anything beyond a first paint, and both are what a
 * real renderer does:
 *
 * - `useEffect` compares its dependency array with the previous render's and
 *   only re-runs when it changed, so an effect cannot re-fire merely because
 *   the component re-rendered.
 * - a re-run's cleanup is called *before* the new body, so a stale timer or
 *   listener is released at the moment its effect is replaced rather than
 *   accumulating until unmount.
 *
 * Without either, a scenario that re-renders drives every effect on every
 * paint: the panel would re-request its device list on each state write, and a
 * test could pass over code that never behaves that way in a browser.
 */
function createReact() {
  const slots = []
  let cursor = 0
  let effects = []
  /** Previous dependency array and cleanup, per effect slot. */
  const effectSlots = []
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
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      // Memorised like React's: a re-render returns the *previous* function when
      // its dependencies are unchanged. Returning a fresh function each time made
      // every callback-typed dependency look changed, so effects that depend on
      // one re-ran on every render — which is not what a browser does, and hid
      // real behaviour behind an artefact of this stand-in.
      const previous = slots[index]
      if (previous !== undefined && deps !== undefined) {
        const same = previous.deps !== undefined
          && deps.length === previous.deps.length
          && deps.every((value, position) => Object.is(value, previous.deps[position]))
        if (same) return previous.fn
      }
      slots[index] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const index = cursor
      cursor += 1
      const previous = slots[index]
      if (previous !== undefined && deps !== undefined) {
        const same = previous.deps !== undefined
          && deps.length === previous.deps.length
          && deps.every((value, position) => Object.is(value, previous.deps[position]))
        if (same) return previous.value
      }
      const value = fn()
      slots[index] = { value, deps }
      return value
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const previous = effectSlots[index]
      const changed = previous === undefined
        || deps === undefined
        || previous.deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, position) => !Object.is(value, previous.deps[position]))
      if (!changed) return
      effects.push({ index, fn, deps })
    },
  }
  const cleanups = []
  return {
    React,
    /**
     * Render once and then run the effects whose dependencies changed, the way a
     * commit does.
     *
     * The hook cursor resets but the state slots keep their values, so a test
     * can render, await the request an effect started, and render again against
     * the state it wrote.
     */
    render(component, props) {
      cursor = 0
      effects = []
      const tree = component(props)
      for (const entry of effects) {
        const previous = effectSlots[entry.index]
        if (typeof previous?.cleanup === 'function') previous.cleanup()
        const cleanup = entry.fn()
        effectSlots[entry.index] = { deps: entry.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      }
      return { tree, effects }
    },
    /** Run every cleanup an earlier render returned. */
    unmount() {
      for (const entry of effectSlots) {
        if (typeof entry?.cleanup === 'function') entry.cleanup()
      }
      effectSlots.length = 0
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
  // The press handler must not bail out on a busy flag. The slice has to name a
  // function that exists: searching for a renamed handler yields an empty string,
  // and every negative assertion about an empty string passes for nothing.
  const start = source.indexOf('function onShotPointerDown')
  const end = source.indexOf('function pressKey')
  assert.ok(start >= 0 && end > start, 'the press handler must exist between the two anchors')
  const handler = source.slice(start, end)
  assert.ok(handler.length > 200, 'the sliced handler must be the real one, not an empty tail')
  assert.equal(/if \(device === null \|\| inputBusy\) return/u.test(handler), false, 'the press handler must not drop a tap')
  // Input must go through a queue that drains in order.
  assert.match(source, /const queueRef = useRef\(\{ device: null, items: \[\], running: false \}\)/u)
  assert.match(source, /queue\.items\.push\(\{ payload, done, device \}\)/u)
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

test('a tap mark is placed in stage pixels, not picture percentages', () => {
  // The stage is the containing block for an absolutely positioned child, and
  // the picture is normally narrower than the stage (a tall phone screen in a
  // wide panel). A percentage of the *picture* therefore put the mark outside
  // the picture entirely — two of three marks landed on the panel background.
  const source = readFileSync(clientPath, 'utf8')
  const helper = source.slice(source.indexOf('function toStagePoint('), source.indexOf('function markPoint('))
  assert.ok(helper.length > 100, 'the stage mapping helper must be found')
  // The offsets are computed from the pointer position minus the stage origin.
  assert.match(helper, /clientX - stageBox\.left/u)
  assert.match(helper, /clientY - stageBox\.top/u)
  // The border is excluded, because an absolutely positioned child is laid out
  // against the padding box, not the border box. `clientLeft` is read instead of
  // `getComputedStyle`, which would force a style recalc on every move.
  assert.match(helper, /stage\.clientLeft/u)
  assert.match(helper, /stage\.clientTop/u)
  // A *call* to getComputedStyle is what forces the recalc; the comment that
  // explains why it is avoided is not the thing under test.
  assert.equal(/getComputedStyle\(/u.test(helper), false, 'a gesture must not force a style recalc')
  // No percentage positioning, which is the form that broke.
  assert.equal(/%`/u.test(helper), false, 'the mark must not be positioned as a percentage')
})

test('a tap is mapped to the device pixel it landed in, and floored', () => {
  // `naturalWidth` is the capture's own pixel count and the Host captures at
  // device resolution, so the ratio is the exact display→device scale. Flooring
  // gives the index of the pixel the press landed in; rounding instead credits
  // the nearer pixel center, which biases every coordinate by up to half a pixel
  // and can reach a pixel past the far edge.
  const source = readFileSync(clientPath, 'utf8')
  // The mapping is shared by the press, the moves, and the release, so a tap and
  // the two ends of a swipe cannot drift apart.
  const helper = source.slice(source.indexOf('function toDevicePoint('), source.indexOf('function toStagePoint('))
  assert.ok(helper.length > 100, 'the device mapping helper must be found')
  assert.match(helper, /Math\.floor\(\(\(clientX - box\.left\) \/ box\.width\) \* width\)/u)
  assert.match(helper, /Math\.floor\(\(\(clientY - box\.top\) \/ box\.height\) \* height\)/u)
  // Both axes are clamped inside the screen, so a point on the very border still
  // names a pixel that exists.
  assert.match(helper, /, 0, width - 1\)/u)
  assert.match(helper, /, 0, height - 1\)/u)
  // A secondary button (a pen's eraser, a middle click) is not a gesture.
  const down = source.slice(source.indexOf('function onShotPointerDown'), source.indexOf('function onShotPointerMove'))
  assert.match(down, /event\.button !== 0/u)
})

test('a burst of taps schedules one sweep timer, not one per tap', () => {
  // Each mark used to schedule its own timeout that rebuilt the whole array. At
  // ~5 fps the picture repaints anyway; a fast double tap should not add two
  // timers and two state updates on top of that.
  const source = readFileSync(clientPath, 'utf8')
  const marker = source.slice(source.indexOf('function markPoint('), source.indexOf('function onShotPointerDown'))
  assert.ok(marker.length > 100, 'the mark helper must be found')
  assert.match(marker, /if \(markSweepRef\.current === null\)/u, 'the timer must only be scheduled when idle')
  assert.match(marker, /setTimeout\(sweepMarks, MARK_LIFETIME_MS\)/u)
  assert.match(source, /const markSweepRef = useRef\(null\)/u)
  // A single fixed-delay timer would strand a mark made just before it fired:
  // the cutoff would spare it and nothing would ever remove it again. The sweep
  // must re-arm for the oldest survivor, and must clear the ref when idle.
  const sweep = source.slice(source.indexOf('const sweepMarks = useCallback'), source.indexOf('function toDevicePoint('))
  assert.ok(sweep.length > 200, 'the sweep helper must be the real one, not an empty tail')
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

// ── a read that belongs to the device it was made for ──────────────────────
// The panel shows one device at a time, and a dump started on one must never be
// rendered under another: every row is a tap, so a stale tree is not a cosmetic
// mismatch — it aims a tap at a control from a screen the user is not looking
// at. These drive the real component with a deferred fetch to pin the ordering.

test('a UI tree that arrives after a device switch is never rendered tappable', async () => {
  // Every row in the UI tree is a tap aimed at a device pixel. A dump started on
  // the previous device therefore cannot be shown under the current one: the
  // user would press a control from a screen that is not on display. The trap is
  // ordering — the old reply lands after the switch — so the second device's own
  // dump is deliberately left pending, which is exactly the window where a stale
  // tree would otherwise be the only thing to render.
  const pending = []
  const { pages, react } = loadClient(async (url) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-a', 'phone-b'] }) } } }
    }
    // Every device read hangs until the test releases it, which is what lets a
    // reply from the previous device arrive after the switch.
    return new Promise((resolve) => { pending.push({ url: String(url), resolve }) })
  })
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  let { tree } = react.render(page, { t: (key) => key })

  // Open the UI card so its effect asks for a dump of the first device.
  elementsOf(tree, 'hdci-card-toggle')[0].props.onClick()
  ;({ tree } = react.render(page, { t: (key) => key }))
  await settle()
  assert.ok(pending.some((entry) => entry.url.includes('device=phone-a')), 'the first device must be the one being dumped')

  // Switch to the second device before the first dump answers.
  elementsOf(tree, 'hdci-select')[0].props.onChange({ target: { value: 'phone-b' } })
  ;({ tree } = react.render(page, { t: (key) => key }))
  await settle()

  // Release only the first device's reply; the second stays in flight.
  const stale = pending.findIndex((entry) => entry.url.includes('device=phone-a'))
  assert.ok(stale >= 0, 'the first device request must still be in flight')
  const [answered] = pending.splice(stale, 1)
  answered.resolve({
    ok: true,
    status: 200,
    clone: () => ({
      json: async () => ({ device: 'phone-a', content: 'Button "Old" clickable @ [0,0][10x10] tap (5, 5)', truncated: false }),
    }),
  })
  await settle()
  ;({ tree } = react.render(page, { t: (key) => key }))
  await settle()
  ;({ tree } = react.render(page, { t: (key) => key }))

  // No tappable row may carry the old device's point, and none of its text may
  // be presented as the current screen.
  const rows = elementsOf(tree, 'hdci-treerow')
  assert.equal(rows.length, 0, 'a dump for another device must not be rendered as rows')
  assert.equal(textOf(tree).join(' ').includes('Button "Old"'), false, 'the old device text must not be shown')
})

// ── the UI tree is a tree ──────────────────────────────────────────────────
// The Host answers both views of one dump, and the panel draws the outline: the
// point of the card is the hierarchy, which a flat list of identical rows cannot
// show however it is styled.

/** The outline the Host now sends, as `/hdc/uitree` would return it. */
const OUTLINE_ROWS = [
  { depth: 0, type: 'Root', text: 'root', clickable: false, tap: { x: 50, y: 50 }, hasChildren: true },
  { depth: 1, type: 'Column', text: 'list', clickable: false, tap: { x: 50, y: 40 }, hasChildren: true },
  { depth: 2, type: 'Button', text: 'Next', clickable: true, tap: { x: 20, y: 12 }, hasChildren: false },
  { depth: 2, type: 'Image', clickable: true, tap: { x: 80, y: 12 }, hasChildren: false },
  { depth: 1, type: 'Text', text: 'Loose', clickable: false, tap: { x: 50, y: 80 }, hasChildren: false },
]

/** Render a panel holding one device whose dump is the given outline. */
async function panelWithOutline(rows, extra = {}) {
  const inputCalls = []
  const { pages, react } = loadClient(async (url, init = {}) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }) } } }
    }
    if (pathname === '/hdc/input') {
      inputCalls.push(JSON.parse(String(init.body ?? '{}')))
      return { ok: true, status: 200, clone() { return { json: async () => ({ device: 'phone-1', command: 'ok' }) } } }
    }
    if (pathname === '/hdc/uitree') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ device: 'phone-1', content: 'outline', truncated: false, rows, ...extra }) } } }
    }
    return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
  })
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  let { tree } = react.render(page, { t: (key) => key })
  elementsOf(tree, 'hdci-card-toggle')[0].props.onClick()
  ;({ tree } = react.render(page, { t: (key) => key }))
  await settle()
  ;({ tree } = react.render(page, { t: (key) => key }))
  return { tree: () => tree, react, page, inputCalls, set: (next) => { tree = next } }
}

test('the panel draws the outline at the depth the Host reported', async () => {
  const panel = await panelWithOutline(OUTLINE_ROWS)
  const rows = elementsOf(panel.tree(), 'hdci-treerow')
  assert.deepEqual(rows.map((row) => row.props['aria-level']), [1, 2, 3, 3, 2], 'each row is one level under its parent')
  // The indent is what makes it read as a tree, and it is a style on the row
  // because a nested element per level would break the single scroll column.
  const pads = rows.map((row) => row.props.style.paddingLeft)
  assert.deepEqual(pads, ['6px', '18px', '30px', '30px', '18px'])
  // The label is the node, not the Host's rendered text line: the two views
  // must not be able to disagree.
  assert.match(textOf(panel.tree()).join(' '), /Button "Next"/u)
})

test('a deep row keeps a readable width instead of indenting forever', async () => {
  // A real dump nests 21 levels. At a fixed step that is ~250 px of left padding
  // in a column narrower than that, so the rows would be all margin and no text.
  const deep = [
    { depth: 0, type: 'Root', clickable: false, tap: { x: 1, y: 1 }, hasChildren: true },
    ...Array.from({ length: 30 }, (_, level) => (
      { depth: level + 1, type: 'Text', text: `L${level + 1}`, clickable: false, tap: { x: 1, y: 1 }, hasChildren: false }
    )),
  ]
  const panel = await panelWithOutline(deep)
  const pads = elementsOf(panel.tree(), 'hdci-treerow').map((row) => Number.parseInt(row.props.style.paddingLeft, 10))
  assert.ok(pads.at(-1) <= 168, `the indent must be capped, got ${pads.at(-1)}px`)
  // It still grows until the cap, so shallow levels stay visually distinct.
  assert.ok(pads[1] > pads[0])
  assert.equal(pads.at(-1), pads.at(-2), 'past the cap every level starts at the same place')
})

test('a row with children folds and unfolds its subtree', async () => {
  const panel = await panelWithOutline(OUTLINE_ROWS)
  const carets = () => elementsOf(panel.tree(), 'hdci-treecaret').filter((node) => node.type === 'button')
  assert.equal(carets().length, 2, 'only the two rows with children get a caret')

  // Fold the Column: its two children go away, its sibling stays.
  carets()[1].props.onClick()
  panel.set(panel.react.render(panel.page, { t: (key) => key }).tree)
  assert.equal(elementsOf(panel.tree(), 'hdci-treerow').length, 3)
  const afterFold = textOf(panel.tree()).join(' ')
  assert.match(afterFold, /Column/u)
  assert.equal(afterFold.includes('"Next"'), false, 'a folded child must not be rendered')
  assert.match(afterFold, /"Loose"/u, 'the next sibling must still be shown')

  // Unfold: the subtree comes back.
  elementsOf(panel.tree(), 'hdci-treecaret').filter((node) => node.type === 'button')[1].props.onClick()
  panel.set(panel.react.render(panel.page, { t: (key) => key }).tree)
  assert.equal(elementsOf(panel.tree(), 'hdci-treerow').length, 5)
})

test('folding a parent hides only its own descendants', async () => {
  // Depth-only rows make this the easy bug to write: hiding everything after the
  // folded row, instead of everything *deeper* than it, would swallow its next
  // sibling as well.
  const panel = await panelWithOutline(OUTLINE_ROWS)
  // Fold the root: everything under it goes, and nothing at its own depth exists.
  elementsOf(panel.tree(), 'hdci-treecaret').filter((node) => node.type === 'button')[0].props.onClick()
  panel.set(panel.react.render(panel.page, { t: (key) => key }).tree)
  assert.equal(elementsOf(panel.tree(), 'hdci-treerow').length, 1)
  assert.match(textOf(panel.tree()).join(' '), /root/u)
})

test('a row press still taps that control, and the caret is not a tap', async () => {
  const panel = await panelWithOutline(OUTLINE_ROWS)
  const bodies = () => elementsOf(panel.tree(), 'hdci-treerow-body').filter((node) => node.type === 'button')
  assert.equal(bodies().length, 5, 'every row in this dump has a tap point')

  bodies()[2].props.onClick()
  await settle()
  assert.deepEqual(panel.inputCalls.at(-1), { device: 'phone-1', action: 'click', x: 20, y: 12 })

  // The caret must never reach the device: it folds locally.
  const before = panel.inputCalls.length
  elementsOf(panel.tree(), 'hdci-treecaret').filter((node) => node.type === 'button')[0].props.onClick()
  await settle()
  assert.equal(panel.inputCalls.length, before, 'folding must not send a tap')
})

test('a Host that answers only flat content still renders rows', async () => {
  // An older Host copy has no `rows`. The panel must degrade to the flat list it
  // used to draw rather than showing nothing.
  const { pages, react } = loadClient(async (url) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }) } } }
    }
    if (pathname === '/hdc/uitree') {
      return {
        ok: true,
        status: 200,
        clone: () => ({ json: async () => ({ device: 'phone-1', content: 'Button "Next" clickable @ [84,1127][1088x168] tap (628, 1211)', truncated: false }) }),
      }
    }
    return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
  })
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  let { tree } = react.render(page, { t: (key) => key })
  elementsOf(tree, 'hdci-card-toggle')[0].props.onClick()
  ;({ tree } = react.render(page, { t: (key) => key }))
  await settle()
  ;({ tree } = react.render(page, { t: (key) => key }))

  const rows = elementsOf(tree, 'hdci-treerow')
  assert.equal(rows.length, 1)
  assert.equal(textOf(tree).join(' ').includes('Button "Next"'), true)
  assert.equal(elementsOf(tree, 'hdci-treecaret').filter((node) => node.type === 'button').length, 0, 'a flat dump has nothing to fold')
})

// ── gestures on the picture: tap and swipe ─────────────────────────────────
// The picture has to carry both, and the difference is a distance the finger
// travels, so these drive the three pointer handlers the way a browser would and
// assert on what actually reaches `/hdc/input`.

/**
 * Render a panel that has one device, and return its live picture plus the
 * `/hdc/input` bodies it sends.
 */
async function pictureWithInputs(routes = {}) {
  const inputCalls = []
  const { pages, react } = loadClient(async (url, init = {}) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }) } } }
    }
    if (pathname === '/hdc/input') {
      inputCalls.push(JSON.parse(String(init.body ?? '{}')))
      return { ok: true, status: 200, clone() { return { json: async () => ({ device: 'phone-1', command: 'ok' }) } } }
    }
    const handler = routes[pathname]
    if (handler !== undefined) {
      const body = await handler(init)
      return { ok: true, status: 200, clone() { return { json: async () => body } } }
    }
    return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
  })
  const page = pages[0].component
  react.render(page, { t: (key) => key, ...{ } })
  await settle()
  const { tree } = react.render(page, { t: (key) => key })
  const picture = elementsOf(tree, 'hdci-shot')[0]
  // A 100x200 picture drawn at its captured size, inside a stage with no border.
  const bounds = { left: 0, top: 0, width: 100, height: 200 }
  const stage = { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => bounds }
  const image = {
    naturalWidth: 100,
    naturalHeight: 200,
    getBoundingClientRect: () => bounds,
    parentElement: stage,
    // The browser's pointer capture, recorded so a gesture that leaves the
    // picture is still delivered.
    captured: [],
    setPointerCapture(id) { this.captured.push(id) },
    releasePointerCapture(id) { this.captured.push(`release:${id}`) },
  }
  /** Drive a full gesture in display pixels. */
  function gesture(from, to, options = {}) {
    const { pointerId = 1, moves = [to], cancel = false } = options
    picture.props.onPointerDown({ button: 0, pointerId, clientX: from.x, clientY: from.y, currentTarget: image })
    for (const point of moves) {
      picture.props.onPointerMove({ pointerId, clientX: point.x, clientY: point.y, currentTarget: image })
    }
    if (cancel) picture.props.onPointerCancel({ pointerId })
    else picture.props.onPointerUp({ button: 0, pointerId, clientX: to.x, clientY: to.y, currentTarget: image })
  }
  return { picture, image, inputCalls, gesture, react, page, reRender: () => react.render(page, { t: (key) => key }) }
}

test('a drag past the threshold is sent as a swipe, in device pixels', async () => {
  const { inputCalls, gesture } = await pictureWithInputs()
  // From (10, 20) to (60, 150) on a picture drawn at its own size.
  gesture({ x: 10, y: 20 }, { x: 60, y: 150 })
  await settle()
  assert.equal(inputCalls.length, 1, 'a drag must send exactly one input')
  assert.deepEqual(inputCalls[0], {
    device: 'phone-1',
    action: 'swipe',
    x: 10,
    y: 20,
    to_x: 60,
    to_y: 150,
    duration_ms: 600,
  })
})

test('a press that stays put is still sent as a tap, on release', async () => {
  const { inputCalls, gesture } = await pictureWithInputs()
  gesture({ x: 30, y: 40 }, { x: 32, y: 41 })
  await settle()
  assert.equal(inputCalls.length, 1, 'a near-stationary press must send one input')
  assert.equal(inputCalls[0].action, 'click')
  // The picture is drawn at its captured size, so display and device pixels
  // coincide here; the release point is what a tap names.
  assert.equal(inputCalls[0].x, 32)
  assert.equal(inputCalls[0].y, 41)
})

test('a cancelled gesture sends nothing at all', async () => {
  // A scroll, a pinch, or the window losing focus takes the gesture away. What
  // the user meant is unknown then, and a guessed tap is a real press on a real
  // device.
  const { inputCalls, gesture } = await pictureWithInputs()
  gesture({ x: 10, y: 10 }, { x: 90, y: 190 }, { cancel: true })
  await settle()
  assert.deepEqual(inputCalls, [], 'a cancelled gesture must not reach the device')
})

test('a swipe that ends where it began is treated as a tap', async () => {
  // A finger that travels out and comes back names no displacement; asking the
  // device to drag zero distance accomplishes nothing.
  const { inputCalls, gesture } = await pictureWithInputs()
  gesture({ x: 50, y: 100 }, { x: 50, y: 100 }, { moves: [{ x: 90, y: 180 }, { x: 50, y: 100 }] })
  await settle()
  assert.equal(inputCalls.length, 1)
  assert.equal(inputCalls[0].action, 'click', 'a zero-distance swipe becomes a tap')
})

test('the swipe being drawn appears while the finger is still down', async () => {
  // The gesture is invisible until it is committed unless the panel draws it, and
  // a swipe whose direction cannot be seen beforehand is hard to aim. The line
  // must therefore exist *before* the release, and be gone after it.
  const { picture, image, inputCalls, reRender } = await pictureWithInputs()
  picture.props.onPointerDown({ button: 0, pointerId: 1, clientX: 10, clientY: 20, currentTarget: image })
  picture.props.onPointerMove({ pointerId: 1, clientX: 60, clientY: 150, currentTarget: image })
  await settle()
  let tree = reRender().tree
  const line = elementsOf(tree, 'hdci-drag-line')[0]
  assert.ok(line !== undefined, 'a swipe in progress must be drawn')
  assert.equal(line.props.x1, 10)
  assert.equal(line.props.y1, 20)
  assert.equal(line.props.x2, 60)
  assert.equal(line.props.y2, 150)
  assert.deepEqual(inputCalls, [], 'nothing is sent until the finger lifts')

  picture.props.onPointerUp({ button: 0, pointerId: 1, clientX: 60, clientY: 150, currentTarget: image })
  await settle()
  tree = reRender().tree
  assert.equal(elementsOf(tree, 'hdci-drag-line').length, 0, 'the line goes away once the gesture ends')
  assert.equal(inputCalls.length, 1, 'and the swipe is sent')
  assert.equal(inputCalls[0].action, 'swipe')
})

test('the picture declares every pointer handler a gesture needs', async () => {
  const { picture } = await pictureWithInputs()
  // Without capture and the move handler, a swipe that leaves the picture stops
  // being reported and the gesture is truncated at the edge.
  assert.equal(typeof picture.props.onPointerDown, 'function')
  assert.equal(typeof picture.props.onPointerMove, 'function')
  assert.equal(typeof picture.props.onPointerUp, 'function')
  assert.equal(typeof picture.props.onPointerCancel, 'function')
  // The press must not also be handled as a click: a click waits for the button
  // to come back up and never arrives for a touch press that drifts.
  assert.equal(picture.props.onClick, undefined)
})

test('the picture refuses a swipe, so the browser never scrolls instead', () => {
  // `touch-action:none` is what keeps a drag on the picture from becoming a page
  // scroll, which would swallow the gesture before the panel saw it.
  const css = panelCss()
  const shot = css.split('\n').find((line) => /^\.hdci-shot\{/u.test(line))
  assert.ok(shot !== undefined, 'the picture rule must exist')
  assert.match(shot, /touch-action:none/u)
  // The drag overlay must not take pointer events, or it would capture the very
  // moves that drive it.
  const drag = css.split('\n').find((line) => /^\.hdci-drag\{/u.test(line))
  assert.ok(drag !== undefined, 'the drag overlay must be styled')
  assert.match(drag, /pointer-events:none/u)
})

