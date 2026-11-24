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
function loadClient(fetchImpl, extraGlobals = {}) {
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
  // A clock the test can push forward. The panel measures long presses and swipe
  // durations with `Date.now()`, so holding a press for 700 ms has to be
  // simulated rather than slept through. It is an *offset* on the real clock, not
  // a frozen value: the panel also arms timers that re-read the clock to decide
  // when to stop, and a clock that never advances would keep them alive forever
  // instead of letting the test finish.
  const clock = { offsetMs: 0 }
  class SandboxDate extends Date {
    static now() { return Date.now() + clock.offsetMs }
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
    Date: SandboxDate,
    fetch: fetchImpl,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    ...extraGlobals,
  }
  vm.runInNewContext(source, sandbox, { filename: clientPath })
  return { ...registered, react, clock }
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
  // The stage element must still render `renderStage()` as its own child; the
  // surrounding props may change, so the assertion is about the call, not about
  // the exact literal spelling of the element.
  assert.match(source, /className: 'hdci-stage'[^}]*\}, renderStage\(\)/u, 'the stage renders the picture itself')
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
  assert.match(source, /const queueRef = useRef\(\{ device: null, generation: 0, items: \[\], running: false, controller: null \}\)/u)
  assert.match(source, /queue\.items\.push\(\{\s*payload,\s*done,\s*device,/u)
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

test('input queued immediately after a device switch drains when the old worker exits', async () => {
  const inputCalls = []
  const { pages, react } = loadClient(async (url, init = {}) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-a', 'phone-b'] }) } } }
    }
    if (pathname === '/hdc/input') {
      const body = JSON.parse(String(init.body ?? '{}'))
      inputCalls.push(body)
      if (body.device === 'phone-a') {
        // Keep A's worker in flight until the device switch aborts it. The
        // rejection queues the old worker's continuation as a microtask, so the
        // click on B below happens while queue.running is still true.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return { ok: true, status: 200, clone() { return { json: async () => ({ device: body.device, command: 'ok' }) } } }
    }
    return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
  })
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  let { tree } = react.render(page, { t: (key) => key })

  const back = elementsOf(tree, 'hdci-btn').find((node) => node.props.title === 'action.back')
  back.props.onClick()
  assert.deepEqual(inputCalls, [{ device: 'phone-a', action: 'key', key: 'Back' }])

  elementsOf(tree, 'hdci-select')[0].props.onChange({ target: { value: 'phone-b' } })
  ;({ tree } = react.render(page, { t: (key) => key }))
  const home = elementsOf(tree, 'hdci-btn').find((node) => node.props.title === 'action.home')
  home.props.onClick()
  await settle()

  assert.deepEqual(inputCalls, [
    { device: 'phone-a', action: 'key', key: 'Back' },
    { device: 'phone-b', action: 'key', key: 'Home' },
  ], 'the old worker must hand the queue to the new generation before exiting')
  ;({ tree } = react.render(page, { t: (key) => key }))
  assert.equal(textOf(tree).join(' ').includes('action.busy'), false, 'the drained queue must not stay busy')
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

test('a folded card does not build the body it is not showing', async () => {
  // The panel re-renders on every coalesced pointer move while a gesture is drawn.
  // Building the tree and log bodies eagerly made each of those renders walk the
  // whole hierarchy and log list for cards that were folded, which is render time
  // taken directly off the stream and the drag line. A folded card must therefore
  // contribute its header and nothing else.
  const panel = await panelWithOutline(OUTLINE_ROWS)
  // The helper opens the first card; the second (logs) is left closed.
  const closed = elementsOf(panel.tree(), 'hdci-card').filter((card) => card.props['data-open'] === 'false')
  assert.ok(closed.length >= 1, 'the panel must have a folded card to test')
  for (const card of closed) {
    const nested = elementsOf(card, 'hdci-card-body')
    assert.deepEqual(nested, [], 'a folded card must not contain a body')
  }
})

test('a drag paints at most once per animation frame, and still ends on the finger', async () => {
  // A pen or a high-rate trackpad reports several positions per painted frame, and
  // each one used to write state. Only the last position before a repaint can be
  // seen, so the extra writes were pure render cost.
  const source = readFileSync(clientPath, 'utf8')
  assert.match(source, /requestAnimationFrame\(/u, 'the drag must be coalesced to a frame')
  assert.match(source, /const queueDrag = useCallback/u)
  // The newest position wins: the frame paints what the ref holds, not a stale
  // closure, so the line ends where the finger did.
  assert.match(source, /const pending = pendingDragRef\.current/u)
  assert.match(source, /if \(pending !== null\) setDrag\(pending\)/u)
  // A gesture that ends, is cancelled, or loses its device must not have a queued
  // frame paint a line back onto the picture.
  assert.match(source, /const cancelDragFrame = useCallback/u)
})

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
 * `/hdc/input` bodies it sends. Pass `{ liveTouch: false }` to simulate a
 * device without the uitest daemon (returning 503 HDC_DAEMON_UNAVAILABLE on
 * live touch actions).
 */
async function pictureWithInputs(options = {}) {
  const { liveTouch = true, unavailableCode = 'HDC_DAEMON_UNAVAILABLE' } = options
  const inputCalls = []
  const { pages, react, clock } = loadClient(async (url, init = {}) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }) } } }
    }
    if (pathname === '/hdc/input') {
      const body = JSON.parse(String(init.body ?? '{}'))
      inputCalls.push(body)
      if (!liveTouch && (body.action === 'touchDown' || body.action === 'touchMove' || body.action === 'touchUp' || body.action === 'touchBatch')) {
        return {
          ok: false,
          status: unavailableCode === 'HDC_BAD_ARGS' ? 400 : 503,
          clone() {
            return {
              json: async () => ({
                error: {
                  code: unavailableCode,
                  message: unavailableCode === 'HDC_BAD_ARGS'
                    ? `unsupported input action: ${body.action}`
                    : 'live touch input requires the uitest daemon on the device',
                },
              }),
            }
          },
        }
      }
      return { ok: true, status: 200, clone() { return { json: async () => ({ device: 'phone-1', command: 'ok' }) } } }
    }
    return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
  })
  const page = pages[0].component
  react.render(page, { t: (key) => key })
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
  function gesture(from, to, gestureOptions = {}) {
    const { pointerId = 1, moves = [to], cancel = false, pointerType = 'touch' } = gestureOptions
    picture.props.onPointerDown({ button: 0, pointerId, pointerType, clientX: from.x, clientY: from.y, currentTarget: image })
    for (const point of moves) {
      picture.props.onPointerMove({ pointerId, pointerType, clientX: point.x, clientY: point.y, currentTarget: image })
    }
    if (cancel) picture.props.onPointerCancel({ pointerId })
    else picture.props.onPointerUp({ button: 0, pointerId, pointerType, clientX: to.x, clientY: to.y, currentTarget: image })
  }
  return { picture, image, inputCalls, gesture, react, page, clock, reRender: () => react.render(page, { t: (key) => key }) }
}

test('a drag past the threshold streams live touchDown and batched release in device pixels', async () => {
  const { inputCalls, gesture } = await pictureWithInputs({ liveTouch: true })
  gesture({ x: 10, y: 20 }, { x: 60, y: 150 })
  await settle()
  assert.equal(inputCalls.length, 2)
  assert.deepEqual(inputCalls[0], { device: 'phone-1', action: 'touchDown', x: 10, y: 20 })
  assert.equal(inputCalls[1].device, 'phone-1')
  assert.equal(inputCalls[1].action, 'touchBatch')
  const steps = inputCalls[1].steps
  assert.ok(Array.isArray(steps) && steps.length >= 2)
  assert.deepEqual(steps.at(-2), { action: 'touchMove', x: 60, y: 150, delayMs: steps.at(-2).delayMs })
  assert.deepEqual(steps.at(-1), { action: 'touchUp', x: 60, y: 150, delayMs: 0 })
})

test('a quick flick whose touchDown is still queued collapses into a single swipe with trailing velocity', async () => {
  const pending = []
  const sent = []
  const { pages, react, clock } = loadClient(async (url, init = {}) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }) } } }
    }
    if (pathname === '/hdc/input') {
      const body = JSON.parse(String(init.body ?? '{}'))
      sent.push(body)
      return new Promise((resolve) => {
        pending.push(() => resolve({ ok: true, status: 200, clone() { return { json: async () => ({ device: 'phone-1', command: 'ok' }) } } }))
      })
    }
    return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
  })
  try {
    const page = pages[0].component
    react.render(page, { t: (key) => key })
    await settle()
    const { tree } = react.render(page, { t: (key) => key })
    const picture = elementsOf(tree, 'hdci-shot')[0]
    const bounds = { left: 0, top: 0, width: 100, height: 200 }
    const image = {
      naturalWidth: 100,
      naturalHeight: 200,
      getBoundingClientRect: () => bounds,
      parentElement: { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => bounds },
    }

    // Hold the queue busy with a prior tap while the quick flick happens.
    picture.props.onPointerDown({ button: 0, pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5, currentTarget: image })
    picture.props.onPointerUp({ button: 0, pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5, currentTarget: image })

    picture.props.onPointerDown({ button: 0, pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 20, currentTarget: image })
    clock.offsetMs += 10
    picture.props.onPointerMove({ pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 80, currentTarget: image })
    clock.offsetMs += 10
    picture.props.onPointerUp({ button: 0, pointerId: 2, pointerType: 'touch', clientX: 70, clientY: 140, currentTarget: image })

    while (pending.length > 0) {
      pending.shift()()
      await settle()
    }
    assert.equal(sent[0].action, 'click')
    assert.equal(sent.length, 2, 'queued touchDown + touchMove must collapse into one swipe')
    assert.equal(sent[1].action, 'swipe')
    assert.equal(sent[1].x, 10)
    assert.equal(sent[1].y, 20)
    assert.equal(sent[1].to_x, 70)
    assert.equal(sent[1].to_y, 140)
    assert.ok(sent[1].velocity > 600)
  } finally {
    clock.offsetMs = 0
  }
})

test('a drag falls back to a swipe when live daemon touch is unavailable', async () => {
  const { inputCalls, gesture } = await pictureWithInputs({ liveTouch: false })
  // First drag probes touchDown, sees HDC_DAEMON_UNAVAILABLE, and falls back to swipe.
  gesture({ x: 10, y: 20 }, { x: 60, y: 150 })
  await settle()
  const swipes = inputCalls.filter((call) => call.action === 'swipe')
  assert.equal(swipes.length, 1, 'fallback must send one swipe on release')
  const [call] = swipes
  assert.equal(call.device, 'phone-1')
  assert.equal(call.x, 10)
  assert.equal(call.y, 20)
  assert.equal(call.to_x, 60)
  assert.equal(call.to_y, 150)
  assert.ok(Number.isInteger(call.velocity), 'the swipe must carry an integer velocity')
  assert.ok(
    call.velocity >= 200 && call.velocity <= 40_000,
    `velocity out of the range the device accepts: ${call.velocity}`,
  )
  assert.equal(call.duration_ms, undefined, 'a swipe must not send a duration')
})

test('a drag falls back cleanly when an older Host rejects touchDown with HDC_BAD_ARGS', async () => {
  const { inputCalls, gesture } = await pictureWithInputs({ liveTouch: false, unavailableCode: 'HDC_BAD_ARGS' })
  gesture({ x: 10, y: 20 }, { x: 60, y: 150 })
  await settle()
  const swipes = inputCalls.filter((call) => call.action === 'swipe')
  assert.equal(swipes.length, 1, 'an older Host rejecting touchDown must fall back to swipe without failing on touchUp')
})

test('a swipe is replayed at the velocity the device actually reads', () => {
  // The fifth positional of `uitest uiInput swipe` is a *velocity*, not a
  // duration. Measured on a HarmonyOS 7.0.0 phone: 199 px/s is refused and 200
  // accepted, 40000 accepted and 40001 refused, each with "The swipe velocity out
  // of range, the default value will be used" — a warning, not an error, so a
  // mistaken unit is never reported and only shows up as a gesture played at the
  // wrong speed.
  const source = readFileSync(clientPath, 'utf8')
  assert.match(source, /const SWIPE_MAX_SPEED_PX_PER_S = 40_000/u)
  assert.match(source, /const SWIPE_MIN_SPEED_PX_PER_S = 200/u)
  assert.match(source, /function swipeVelocity\(elapsedMs, distancePx\)/u)
  // The pace is derived from distance and elapsed time, then clamped to the band
  // the device accepts so it is never silently swapped for the default one.
  assert.match(source, /clamp\(observed, SWIPE_MIN_SPEED_PX_PER_S, SWIPE_MAX_SPEED_PX_PER_S\)/u)
  assert.match(source, /velocity: trailingSwipeVelocity\(/u)
  // The old, wrong shape must not come back.
  assert.doesNotMatch(source, /duration_ms: swipeDuration\(/u)
  assert.doesNotMatch(source, /function swipeDuration\(/u)
  // The clock starts when the press *becomes* a swipe, not when it went down.
  assert.match(source, /if \(!gesture\.swiping\) gesture\.swipeStartedAt = now/u)
})

test('fallback swipe uses trailing release speed for a flick and stays slow after a pause', async () => {
  const { picture, image, inputCalls, clock } = await pictureWithInputs({ liveTouch: false })
  try {
    // Probe once so fallback mode is active.
    picture.props.onPointerDown({ button: 0, pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10, currentTarget: image })
    picture.props.onPointerMove({ pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 10, currentTarget: image })
    picture.props.onPointerUp({ button: 0, pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 10, currentTarget: image })
    await settle()
    inputCalls.length = 0

    // Slow drag for 900 ms, then fast 50 px flick in 20 ms -> trailing speed = 2500 px/s.
    picture.props.onPointerDown({ button: 0, pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 20, currentTarget: image })
    clock.offsetMs += 900
    picture.props.onPointerMove({ pointerId: 2, pointerType: 'touch', clientX: 30, clientY: 20, currentTarget: image })
    clock.offsetMs += 20
    picture.props.onPointerUp({ button: 0, pointerId: 2, pointerType: 'touch', clientX: 80, clientY: 20, currentTarget: image })
    await settle()
    assert.equal(inputCalls.at(-1).action, 'swipe')
    assert.equal(inputCalls.at(-1).velocity, 2500)

    // Fast drag followed by a 200 ms pause before lifting -> slow speed (200 px/s), no accidental fling.
    picture.props.onPointerDown({ button: 0, pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 40, currentTarget: image })
    clock.offsetMs += 20
    picture.props.onPointerMove({ pointerId: 3, pointerType: 'touch', clientX: 90, clientY: 40, currentTarget: image })
    clock.offsetMs += 200
    picture.props.onPointerUp({ button: 0, pointerId: 3, pointerType: 'touch', clientX: 90, clientY: 40, currentTarget: image })
    await settle()
    assert.equal(inputCalls.at(-1).action, 'swipe')
    assert.equal(inputCalls.at(-1).velocity, 200)

    // Slow drag followed by a same-tick flick at release keeps the high flick speed instead of using fullElapsed.
    picture.props.onPointerDown({ button: 0, pointerId: 4, pointerType: 'touch', clientX: 10, clientY: 60, currentTarget: image })
    clock.offsetMs += 900
    picture.props.onPointerMove({ pointerId: 4, pointerType: 'touch', clientX: 30, clientY: 60, currentTarget: image })
    picture.props.onPointerUp({ button: 0, pointerId: 4, pointerType: 'touch', clientX: 80, clientY: 60, currentTarget: image })
    await settle()
    assert.equal(inputCalls.at(-1).action, 'swipe')
    assert.equal(inputCalls.at(-1).velocity, 40_000)

    // Drag where the preceding move fell just outside the trailing window and release shares the last move point.
    picture.props.onPointerDown({ button: 0, pointerId: 5, pointerType: 'touch', clientX: 10, clientY: 80, currentTarget: image })
    clock.offsetMs += 770
    picture.props.onPointerMove({ pointerId: 5, pointerType: 'touch', clientX: 30, clientY: 80, currentTarget: image })
    clock.offsetMs += 130
    picture.props.onPointerMove({ pointerId: 5, pointerType: 'touch', clientX: 90, clientY: 80, currentTarget: image })
    clock.offsetMs += 5
    picture.props.onPointerUp({ button: 0, pointerId: 5, pointerType: 'touch', clientX: 90, clientY: 80, currentTarget: image })
    await settle()
    assert.equal(inputCalls.at(-1).action, 'swipe')
    assert.equal(inputCalls.at(-1).velocity, Math.round((60 / 130) * 1000))
  } finally {
    clock.offsetMs = 0
  }
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

test('a cancelled gesture before threshold sends nothing, and after touchDown releases with touchUp', async () => {
  const preThreshold = await pictureWithInputs()
  preThreshold.gesture({ x: 10, y: 10 }, { x: 12, y: 12 }, { cancel: true })
  await settle()
  assert.deepEqual(preThreshold.inputCalls, [], 'a pre-threshold cancelled gesture must not reach the device')

  const postThreshold = await pictureWithInputs({ liveTouch: true })
  postThreshold.gesture({ x: 10, y: 10 }, { x: 90, y: 190 }, { moves: [{ x: 60, y: 100 }], cancel: true })
  await settle()
  assert.equal(postThreshold.inputCalls.at(-1).action, 'touchUp', 'cancelling after touchDown must lift the finger')
  assert.deepEqual(
    { x: postThreshold.inputCalls.at(-1).x, y: postThreshold.inputCalls.at(-1).y },
    { x: 60, y: 100 },
  )
})

test('a swipe that ends where it began becomes a tap in fallback mode and lifts cleanly in live mode', async () => {
  const fallback = await pictureWithInputs({ liveTouch: false })
  // Prime fallback detection.
  fallback.gesture({ x: 10, y: 10 }, { x: 40, y: 10 })
  await settle()
  fallback.inputCalls.length = 0

  fallback.gesture({ x: 50, y: 100 }, { x: 50, y: 100 }, { moves: [{ x: 90, y: 180 }, { x: 50, y: 100 }] })
  await settle()
  assert.equal(fallback.inputCalls.length, 1)
  assert.equal(fallback.inputCalls[0].action, 'click', 'a zero-distance fallback swipe becomes a tap')

  const live = await pictureWithInputs({ liveTouch: true })
  live.gesture({ x: 50, y: 100 }, { x: 50, y: 100 }, { moves: [{ x: 90, y: 180 }, { x: 50, y: 100 }] })
  await settle()
  assert.equal(live.inputCalls.at(-1).action, 'touchUp', 'a live drag that returns to start must lift the finger')
})

test('live drag hides the dashed line while streaming, and fallback mode still draws it until release', async () => {
  // Live follow-finger mode: no dashed line overlay, immediate touchDown + touchMove while still pressed.
  const live = await pictureWithInputs({ liveTouch: true })
  live.picture.props.onPointerDown({ button: 0, pointerId: 1, clientX: 10, clientY: 20, currentTarget: live.image })
  live.picture.props.onPointerMove({ pointerId: 1, clientX: 60, clientY: 150, currentTarget: live.image })
  await settle()
  let liveTree = live.reRender().tree
  assert.equal(elementsOf(liveTree, 'hdci-drag-line').length, 0, 'live follow-finger drag must hide the dashed line')
  assert.deepEqual(live.inputCalls, [
    { device: 'phone-1', action: 'touchDown', x: 10, y: 20 },
    { device: 'phone-1', action: 'touchMove', x: 60, y: 150 },
  ])
  live.picture.props.onPointerUp({ button: 0, pointerId: 1, clientX: 60, clientY: 150, currentTarget: live.image })
  await settle()
  assert.equal(live.inputCalls.at(-1).action, 'touchUp')

  // Fallback mode: dashed line appears while finger is down and clears on release.
  const fallback = await pictureWithInputs({ liveTouch: false })
  fallback.gesture({ x: 10, y: 10 }, { x: 40, y: 10 })
  await settle()
  fallback.inputCalls.length = 0

  fallback.picture.props.onPointerDown({ button: 0, pointerId: 2, clientX: 10, clientY: 20, currentTarget: fallback.image })
  fallback.picture.props.onPointerMove({ pointerId: 2, clientX: 60, clientY: 150, currentTarget: fallback.image })
  await settle()
  let tree = fallback.reRender().tree
  const line = elementsOf(tree, 'hdci-drag-line')[0]
  assert.ok(line !== undefined, 'a fallback swipe in progress must be drawn')
  assert.equal(line.props.x1, 10)
  assert.equal(line.props.y1, 20)
  assert.equal(line.props.x2, 60.5)
  assert.equal(line.props.y2, 150.5)
  assert.deepEqual(fallback.inputCalls, [], 'nothing is sent in fallback mode until the finger lifts')

  fallback.picture.props.onPointerUp({ button: 0, pointerId: 2, clientX: 60, clientY: 150, currentTarget: fallback.image })
  await settle()
  tree = fallback.reRender().tree
  assert.equal(elementsOf(tree, 'hdci-drag-line').length, 0, 'the line goes away once the gesture ends')
  assert.equal(fallback.inputCalls.length, 1, 'and the swipe is sent')
  assert.equal(fallback.inputCalls[0].action, 'swipe')
})

test('rapid touchMove events coalesce to the latest point while an input is in flight', async () => {
  const pending = []
  const sent = []
  const { pages, react } = loadClient(async (url, init = {}) => {
    const pathname = String(url).split('?')[0]
    if (pathname === '/hdc/devices') {
      return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }) } } }
    }
    if (pathname === '/hdc/input') {
      const body = JSON.parse(String(init.body ?? '{}'))
      sent.push(body)
      return new Promise((resolve) => {
        pending.push(() => resolve({ ok: true, status: 200, clone() { return { json: async () => ({ device: 'phone-1', command: 'ok' }) } } }))
      })
    }
    return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
  })
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  const { tree } = react.render(page, { t: (key) => key })
  const picture = elementsOf(tree, 'hdci-shot')[0]
  const bounds = { left: 0, top: 0, width: 100, height: 200 }
  const image = {
    naturalWidth: 100,
    naturalHeight: 200,
    getBoundingClientRect: () => bounds,
    parentElement: { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => bounds },
  }

  picture.props.onPointerDown({ button: 0, pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 20, currentTarget: image })
  // While touchDown is in flight, fire three move events rapidly.
  picture.props.onPointerMove({ pointerId: 1, pointerType: 'touch', clientX: 30, clientY: 50, currentTarget: image })
  picture.props.onPointerMove({ pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 80, currentTarget: image })
  picture.props.onPointerMove({ pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 120, currentTarget: image })

  // Drain each in-flight request one by one.
  while (pending.length > 0) {
    pending.shift()()
    await settle()
  }
  assert.deepEqual(sent, [
    { device: 'phone-1', action: 'touchDown', x: 10, y: 20 },
    { device: 'phone-1', action: 'touchMove', x: 50, y: 120 },
  ])
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

test('a press is acknowledged on the way down, before the gesture is known', async () => {
  // Deciding tap-versus-swipe has to wait for the release, but *feedback* must
  // not: the device's own reply is a later frame, and leaving the first ~0.4 s of
  // every gesture unacknowledged reads as a press that did not land.
  const { picture, image, reRender } = await pictureWithInputs()
  picture.props.onPointerDown({ button: 0, pointerId: 1, clientX: 40, clientY: 80, currentTarget: image })
  await settle()
  const tree = reRender().tree
  const marks = elementsOf(tree, 'hdci-ripple')
  assert.equal(marks.length, 1, 'the press must leave a mark immediately')
  assert.equal(marks[0].props.style.left, '40px')
  assert.equal(marks[0].props.style.top, '80px')
})

test('a cancelled gesture takes its press mark with it', async () => {
  // The mark claims an input. If the gesture was cancelled no input was sent, so
  // leaving the mark would report something that never reached the device.
  const { picture, image, reRender } = await pictureWithInputs()
  picture.props.onPointerDown({ button: 0, pointerId: 1, clientX: 40, clientY: 80, currentTarget: image })
  await settle()
  picture.props.onPointerCancel({ pointerId: 1 })
  await settle()
  const tree = reRender().tree
  assert.equal(elementsOf(tree, 'hdci-ripple').length, 0, 'a cancelled press leaves no mark behind')
})

test('a press that travels out and comes back is a swipe, not a tap', () => {
  // Judging the gesture by where it was *released* made a scroll that returns to
  // near its start read as a tap, so the device got a click where the user meant
  // to scroll. The furthest the pointer got is what decides.
  return (async () => {
    const { inputCalls, gesture } = await pictureWithInputs({ liveTouch: false })
    gesture({ x: 50, y: 100 }, { x: 52, y: 102 }, { moves: [{ x: 90, y: 180 }, { x: 52, y: 102 }] })
    await settle()
    const swipes = inputCalls.filter((call) => call.action === 'swipe')
    assert.equal(swipes.length, 1, 'travelling past the threshold decides the gesture, even if it returns')
  })()
})

test('a mouse needs a longer slip than a fingertip before it counts as a drag', async () => {
  // Ten pixels is normal wobble for a fingertip but a deliberate drag for a
  // mouse, and a button clicked with a 12 px slip used to scroll instead.
  const { inputCalls, gesture } = await pictureWithInputs()
  gesture({ x: 10, y: 10 }, { x: 22, y: 10 }, { pointerType: 'mouse' })
  await settle()
  assert.equal(inputCalls.length, 1)
  assert.equal(inputCalls[0].action, 'click', 'a small mouse slip stays a click')

  const touch = await pictureWithInputs()
  touch.gesture({ x: 10, y: 10 }, { x: 22, y: 10 }, { pointerType: 'touch' })
  await settle()
  assert.equal(touch.inputCalls[0].action, 'touchDown', 'the same drag from a finger enters drag mode')
})

test('a held press is sent as a long press, not a click', async () => {
  // A real device treats a held press as its own gesture — usually a context menu
  // or a drag handle. Sending a click for it performs an action the user did not
  // make.
  const { picture, image, inputCalls, clock } = await pictureWithInputs()
  try {
    picture.props.onPointerDown({ button: 0, pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 80, currentTarget: image })
    // Hold past the long-press threshold without moving.
    clock.offsetMs += 700
    picture.props.onPointerUp({ button: 0, pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 80, currentTarget: image })
    await settle()
  } finally {
    clock.offsetMs = 0
  }
  assert.equal(inputCalls.length, 1)
  assert.equal(inputCalls[0].action, 'longClick')
})

test('a quick press is still a click, so the long press does not swallow taps', async () => {
  const { gesture, inputCalls } = await pictureWithInputs()
  gesture({ x: 40, y: 80 }, { x: 40, y: 80 })
  await settle()
  assert.equal(inputCalls.length, 1)
  assert.equal(inputCalls[0].action, 'click')
})

test('a frame-sequence recording offers its path, not a JSON download', async () => {
  // The artifact route answers a directory with a JSON listing, so an
  // "open the recording" link for a sequence hands the user a document instead
  // of a video. The frames are still kept; only the misleading link goes away.
  const { pages, react } = loadClient(fetchWith({
    '/hdc/devices': async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }),
    '/hdc/record': async () => ({
      device: 'phone-1',
      kind: 'frames',
      artifactId: 'a-frames',
      savedPath: '/tmp/clip-frames',
      frames: 12,
      seconds: 5,
      bytes: 900,
    }),
  }))
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  let { tree } = react.render(page, { t: (key) => key })

  // Start a recording and let it settle.
  const startButton = tree.children
    .flat(Infinity)
    .filter((child) => child?.props?.onClick !== undefined)
  elementsOf(tree, 'hdci-btn').find((node) => node.props.title === 'shot.record').props.onClick()
  await settle()
  await settle()
  ;({ tree } = react.render(page, { t: (key) => key }))

  assert.equal(startButton !== undefined, true)
  const links = elementsOf(tree, 'hdci-link')
  assert.equal(links.length, 0, 'a frame sequence must not offer a download link')
  assert.match(textOf(tree).join(' '), /shot\.recordFrames/u, 'the path is still reported')
})

test('a drag that leaves the picture says so, instead of a frozen readout', () => {
  // Past the edge the device coordinate stops advancing because it is clamped.
  // Without a word about it the status line looks stuck while the finger keeps
  // moving.
  const source = readFileSync(clientPath, 'utf8')
  const move = source.slice(source.indexOf('function onShotPointerMove'), source.indexOf('function onShotPointerUp'))
  assert.match(move, /const atEdge = event\.clientX < box\.left/u, 'leaving the picture must be detected')
  // The position is queued for the next frame rather than written on the spot, so
  // the assertion is about the payload reaching the drag state, not about which
  // state setter carries it.
  assert.match(move, /queueDrag\(\{ from, to, start: gesture\.start, current, atEdge, live: gesture\.live \}\)/u)
  const bar = source.slice(source.indexOf('function renderStageBar'), source.indexOf('function renderActions'))
  assert.match(bar, /drag\.atEdge \?/u, 'the status line must mention the edge')
  assert.match(bar, /t\('shot\.edgeReached'\)/u)
})

test('every mouse state on the picture uses a centered touch-ring cursor without jumping to grabbing', async () => {
  const { pages, react } = loadClient(fetchWith({
    '/hdc/devices': async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }),
  }))
  const page = pages[0].component
  react.render(page, { t: (key) => key })
  await settle()
  const { tree } = react.render(page, { t: (key) => key })
  const styleNode = tree.children.find((node) => node?.type === 'style')
  assert.ok(styleNode !== undefined, 'the rendered tree includes the stylesheet')
  const renderedCss = String(styleNode.children[0] ?? '')

  const idleRule = renderedCss.split('\n').find((line) => /^\.hdci-shot\{/u.test(line))
  const pressRule = renderedCss.split('\n').find((line) => /^\.hdci-shot:active,\.hdci-stage\[data-pressing='true'\] \.hdci-shot\{/u.test(line))
  const longPressRule = renderedCss.split('\n').find((line) => /^\.hdci-stage\[data-longpress='true'\] \.hdci-shot\{/u.test(line))
  const dragRule = renderedCss.split('\n').find((line) => /^\.hdci-stage\[data-dragging='true'\] \.hdci-shot\{/u.test(line))

  for (const [name, rule] of [
    ['idle', idleRule],
    ['press', pressRule],
    ['longpress', longPressRule],
    ['drag', dragRule],
  ]) {
    assert.ok(rule !== undefined, `${name} cursor rule must exist`)
    assert.match(
      rule,
      /cursor:url\("data:image\/svg\+xml,%3Csvg xmlns='http:\/\/www\.w3\.org\/2000\/svg' width='24' height='24' viewBox='0 0 24 24'%3E[\s\S]+%3C\/svg%3E"\) 12 12, /u,
      `${name} cursor must use a 24x24 SVG centered at 12 12`,
    )
  }
  assert.equal(/cursor:grabbing\b/u.test(dragRule), false, 'drag state must use the touch-ring cursor rather than system grabbing')
})

test('the stage exposes pressing and dragging state attributes across pointer gestures', async () => {
  const { picture, image, reRender } = await pictureWithInputs({ liveTouch: true })
  const stageOf = (tree) => elementsOf(tree, 'hdci-stage')[0]

  assert.equal(stageOf(reRender().tree).props['data-pressing'], undefined)
  assert.equal(stageOf(reRender().tree).props['data-dragging'], undefined)

  picture.props.onPointerDown({ button: 0, pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 80, currentTarget: image })
  await settle()
  let stage = stageOf(reRender().tree)
  assert.equal(stage.props['data-pressing'], 'true', 'pointerdown marks the stage as pressing immediately')
  assert.equal(stage.props['data-dragging'], undefined)

  picture.props.onPointerMove({ pointerId: 1, pointerType: 'mouse', clientX: 90, clientY: 80, currentTarget: image })
  await settle()
  stage = stageOf(reRender().tree)
  assert.equal(stage.props['data-dragging'], 'true', 'moving past threshold marks the stage as dragging')

  picture.props.onPointerUp({ button: 0, pointerId: 1, pointerType: 'mouse', clientX: 90, clientY: 80, currentTarget: image })
  await settle()
  stage = stageOf(reRender().tree)
  assert.equal(stage.props['data-pressing'], undefined, 'pointerup clears pressing state')
  assert.equal(stage.props['data-dragging'], undefined, 'pointerup clears dragging state')

  picture.props.onPointerDown({ button: 0, pointerId: 2, pointerType: 'mouse', clientX: 40, clientY: 80, currentTarget: image })
  await settle()
  assert.equal(stageOf(reRender().tree).props['data-pressing'], 'true')
  picture.props.onPointerCancel({ pointerId: 2 })
  await settle()
  stage = stageOf(reRender().tree)
  assert.equal(stage.props['data-pressing'], undefined, 'pointercancel clears pressing state')
  assert.equal(stage.props['data-longpress'], undefined, 'pointercancel clears longpress state')
})

test('when ReadableStream and createImageBitmap exist, the panel streams frames onto a canvas immediately and maps scaled taps to physical pixels', async () => {
  const inputCalls = []
  let streamController
  let streamAborted = false
  const drawnBitmaps = []
  const decodedBlobs = []
  let pendingBitmapResolve = null

  const fakeCanvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 304, height: 672 }),
    parentElement: { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0, width: 304, height: 672 }) },
    getContext: () => ({
      drawImage(bitmap) {
        drawnBitmaps.push({ width: bitmap.width, height: bitmap.height, closed: bitmap.closed })
      },
    }),
  }

  class FakeBlob {
    constructor(parts, opts) {
      this.bytes = Buffer.concat(parts.map((p) => Buffer.from(p)))
      this.type = opts?.type ?? ''
    }
  }

  const fakeHeaders = new Map([
    ['content-type', 'multipart/x-mixed-replace; boundary=dsh-hdc-frame'],
    ['x-hdc-stream-mode', 'daemon'],
    ['x-hdc-stream-scale', '0.5'],
    ['x-hdc-device-width', '1216'],
    ['x-hdc-device-height', '2688'],
  ])

  const { pages, react } = loadClient(
    async (url, init = {}) => {
      const pathname = String(url).split('?')[0]
      if (pathname === '/hdc/devices') {
        return { ok: true, status: 200, clone() { return { json: async () => ({ hdcPath: '/x/hdc', devices: ['phone-1'] }) } } }
      }
      if (pathname === '/hdc/stream') {
        init.signal?.addEventListener('abort', () => { streamAborted = true }, { once: true })
        const body = new ReadableStream({
          start(controller) { streamController = controller },
        })
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => fakeHeaders.get(String(k).toLowerCase()) ?? null },
          body,
        }
      }
      if (pathname === '/hdc/input') {
        inputCalls.push(JSON.parse(String(init.body ?? '{}')))
        return { ok: true, status: 200, clone() { return { json: async () => ({ device: 'phone-1', command: 'ok' }) } } }
      }
      return { ok: true, status: 200, clone() { return { json: async () => ({}) } } }
    },
    {
      Blob: FakeBlob,
      ReadableStream,
      createImageBitmap: async (blob) => {
        decodedBlobs.push(blob)
        // Hold the second decode open so two arriving frames coalesce to the newest.
        if (decodedBlobs.length === 2) {
          await new Promise((resolve) => { pendingBitmapResolve = resolve })
        }
        const isLandscape = blob.bytes.includes(0xaa)
        const bitmap = {
          width: isLandscape ? 1344 : 608,
          height: isLandscape ? 608 : 1344,
          closed: false,
          close() { this.closed = true },
        }
        return bitmap
      },
    },
  )

  const formatT = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const page = pages[0].component
  react.render(page, { t: formatT })
  await settle()
  let { tree } = react.render(page, { t: formatT })
  let canvas = elementsOf(tree, 'hdci-shot')[0]
  assert.equal(canvas.type, 'canvas', 'streaming mode renders a canvas element')
  // Bind ref the way React does during commit.
  canvas.props.ref.current = fakeCanvas

  // Enqueue frame 1 split across two chunks, WITHOUT any trailing boundary after it.
  const frame1 = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
  const part1 = Buffer.concat([
    Buffer.from('--dsh-hdc-frame\r\ncontent-type: image/jpeg\r\ncontent-length: 6\r\n\r\n'),
    frame1.subarray(0, 3),
  ])
  streamController.enqueue(new Uint8Array(part1))
  await settle()
  assert.equal(drawnBitmaps.length, 0, 'incomplete payload does not decode yet')
  streamController.enqueue(new Uint8Array(Buffer.concat([frame1.subarray(3), Buffer.from('\r\n')])))
  await settle()
  assert.equal(drawnBitmaps.length, 1, 'frame 1 renders immediately on content-length completion without waiting for next boundary')
  assert.equal(fakeCanvas.width, 608)
  assert.equal(fakeCanvas.height, 1344)

  ;({ tree } = react.render(page, { t: formatT }))
  assert.match(textOf(tree).join(' '), /shot\.size \{"width":1216,"height":2688\}/u, 'stage bar shows full physical device size')

  // Tap center of the 304x672 canvas -> must map to physical 1216x2688 center (608, 1344), not 608x1344 center!
  canvas = elementsOf(tree, 'hdci-shot')[0]
  canvas.props.onPointerDown({ button: 0, pointerId: 1, clientX: 152, clientY: 336, currentTarget: fakeCanvas })
  canvas.props.onPointerUp({ button: 0, pointerId: 1, clientX: 152, clientY: 336, currentTarget: fakeCanvas })
  await settle()
  assert.deepEqual(inputCalls[0], { device: 'phone-1', action: 'click', x: 608, y: 1344 })

  // Burst frame 2 (stalled in decode), frame 3 (stale), and frame 4 (landscape 0xaa): frame 3 must be dropped.
  const makePart = (bytes) => Buffer.concat([
    Buffer.from(`--dsh-hdc-frame\r\ncontent-type: image/jpeg\r\ncontent-length: ${bytes.length}\r\n\r\n`),
    bytes,
    Buffer.from('\r\n'),
  ])
  streamController.enqueue(new Uint8Array(makePart(Buffer.from([0xff, 0xd8, 0x11, 0xff, 0xd9]))))
  await settle()
  streamController.enqueue(new Uint8Array(makePart(Buffer.from([0xff, 0xd8, 0x22, 0xff, 0xd9]))))
  streamController.enqueue(new Uint8Array(makePart(Buffer.from([0xff, 0xd8, 0xaa, 0xff, 0xd9]))))
  await settle()
  pendingBitmapResolve()
  await settle()
  assert.equal(decodedBlobs.length, 3, 'intermediate frame 3 must be coalesced away while decode is busy')
  assert.equal(fakeCanvas.width, 1344)
  assert.equal(fakeCanvas.height, 608)

  // Unmounting aborts the live fetch stream cleanly.
  react.unmount()
  assert.equal(streamAborted, true)
})
