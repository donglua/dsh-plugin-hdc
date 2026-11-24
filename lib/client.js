/**
 * dsh-plugin-hdc — browser half.
 *
 * Hand-written module-loader bundle (no build step): the DSH client module
 * loader executes this script and takes the returned `inject`/`apply`, then
 * mounts the plugin into the browser-side cordis runtime. There is no JSX
 * compiler in the browser, so every element is built with `React.createElement`.
 *
 * Contributions:
 *   - `sidebar.panellist` → the sidebar entry that opens the panel
 *   - `main` (keyed by `hdc-panel`) → the full-page device control panel
 *
 * Every device call goes through this page's own origin (`/hdc/...`), served by
 * the plugin's Host half. The browser never runs `hdc` itself, so no client
 * path or device serial escapes into a shell from here.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-hdc',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Locale namespace; the `t` seat and the panellist label both read it. */
    const NS = 'hdc.panel'

    /**
     * Panel id. `sidebar.panellist` carries it as `id`, `main` carries it as
     * `key`; the layout only switches pages when the two agree.
     */
    const PANEL_ID = 'hdc-panel'

    /** Stable empty list, so the "no devices" branch never allocates. */
    const NO_DEVICES = Object.freeze([])

    /** Stable empty mark list, for the same reason on the picture's overlay. */
    const NO_MARKS = Object.freeze([])

    /** Stable empty fold set, so an unfolded tree never allocates one. */
    const NO_COLLAPSED = Object.freeze(new Set())

    /**
     * Indent per outline level, and the cap it stops growing at.
     *
     * The panel column is under half the window, so a real dump's twenty levels
     * of ×14 px would leave almost no width for the label. Past the cap every
     * deeper row starts at the same place: the caret still says which row owns
     * which, and readable text is worth more than a perfectly scaled indent.
     */
    const TREE_INDENT_PX = 12
    const TREE_INDENT_MAX_PX = 168

    /**
     * How long a tap mark stays on screen.
     *
     * It has to outlast the CSS animation (420 ms) or the mark would vanish
     * mid-fade, and it is also the window the sweep timer prunes to, so the two
     * are stated together here rather than as a bare number in two places.
     */
    const MARK_LIFETIME_MS = 450

    /**
     * How far a press may drift before it counts as a swipe instead of a tap.
     *
     * Measured on the *displayed* picture, in CSS pixels, not in device pixels:
     * the gesture a finger makes is the same size regardless of how far the
     * capture was scaled down, so the threshold has to be a screen distance.
     *
     * Two thresholds, because the two input devices have different noise. A
     * fingertip wobbles by a few pixels on any press it means as a tap, while a
     * mouse is precise to the pixel — and a mouse also drags on the way to a
     * click far less often. One number cannot serve both: ten pixels is right for
     * touch and too small for a mouse, where a twelve-pixel slip while clicking a
     * button became a scroll instead.
     */
    const SWIPE_THRESHOLD_TOUCH_PX = 10
    const SWIPE_THRESHOLD_MOUSE_PX = 16

    /**
     * How long a press may stay still before releasing it is a long press.
     *
     * A real device treats a held press as its own gesture (a context menu, a
     * drag handle), and sending a plain click for it is a different action from
     * the one the user made. 500 ms matches the platform's own long-press
     * threshold closely enough that a deliberate hold reads the same way.
     */
    const LONG_PRESS_MS = 500

    /**
     * How long a measured gesture is trusted as a pace, in milliseconds.
     *
     * A press held still for ten seconds before it moves is not a ten-second
     * swipe, so the *elapsed* time is clamped before it is turned into a speed.
     * This bounds the measurement, not the replay: what the device receives is
     * always a speed, and the device decides how long the movement takes.
     */
    const SWIPE_MIN_ELAPSED_MS = 1
    const SWIPE_MAX_ELAPSED_MS = 1200
    const TRAILING_VELOCITY_WINDOW_MS = 120

    /**
     * The speed range `uitest uiInput swipe` accepts, in device pixels per
     * second.
     *
     * The fifth positional argument of `uitest uiInput swipe` is a **velocity**,
     * not a duration: its own usage line reads `swipe/drag <from_x> <from_y>
     * <to_x> <to_y> [velocity]`, and it accepts 200–40000 px/s. Both ends are
     * measured on a HarmonyOS 7.0.0 device — 199 is refused and 200 is accepted,
     * 40000 is accepted and 40001 is refused — with the warning "The swipe
     * velocity out of range, the default value will be used".
     *
     * That warning is easy to miss, which is why this band has to be right: an
     * out-of-range value is not an error, the client silently substitutes its own
     * default pace and the gesture plays at a speed nobody asked for.
     *
     * The device's own floor is 200, and there is no reason to stay above it: a
     * slow, deliberate drag is a legitimate gesture. The upper bound is the
     * device's, not a guess — a fast flick genuinely is 5000 px/s, and clamping it
     * to a lower number would replay it slower than it was made.
     */
    const SWIPE_MIN_SPEED_PX_PER_S = 200
    const SWIPE_MAX_SPEED_PX_PER_S = 40_000

    /**
     * The pace sent when the gesture carried no usable measurement.
     *
     * 600 px/s is the device's own default, so an unmeasured replay behaves the
     * way a plain `uitest uiInput swipe` would rather than inventing a pace.
     */
    const SWIPE_DEFAULT_SPEED_PX_PER_S = 600

    // ── dictionaries ─────────────────────────────────────────────────────────
    // Inlined rather than fetched: a hand-written bundle has no asset pipeline,
    // and `ctx.locale.register` is the only channel the slot renderer reads for
    // the framework-injected `t` seat.

    const zh = {
      panel: '鸿蒙设备',
      title: '鸿蒙设备',
      subtitle: '通过 hdc 实时看屏、点按与滑动、读取 UI 树与日志',
      'device.label': '设备',
      'device.select': '选择设备',
      'device.refresh': '刷新设备',
      'device.none': '未选择设备',
      'device.detected': 'hdc：{path}',
      'action.back': '返回',
      'action.home': '主页',
      'action.power': '电源',
      'action.busy': '执行中…',
      'action.send': '输入',
      'action.textPlaceholder': '输入文字后回车，发到设备上聚焦的输入框',
      'action.textDone': '已输入文字',
      'shot.tapHint': '点画面即点按，按住拖动则滑动',
      'shot.tapDone': '已点击 ({x}, {y})',
      'shot.swipeDone': '已滑动 ({x}, {y}) → ({toX}, {toY})',
      'shot.swipeHint': '拖动中 ({x}, {y}) → ({toX}, {toY})',
      'shot.longPressDone': '已长按 ({x}, {y})',
      'shot.edgeReached': '已到画面边缘',
      'shot.keyDone': '已发送 {key}',
      'shot.size': '{width} × {height} px',
      'shot.error': '画面连接断了，点重试重新连上设备',
      'shot.live': '实时画面',
      'shot.starting': '正在连接画面…',
      'shot.snapshot': '截图',
      'shot.snapshotDone': '已截图：{name}',
      'shot.snapshotOpen': '打开截图',
      'shot.record': '录屏',
      'shot.recording': '录制中 {seconds}s / {total}s',
      'shot.recordDone': '已录屏：{name}',
      'shot.recordOpen': '打开录屏',
      'shot.recordFrames': '已保存为帧序列：{name}',
      'shot.recordSeconds': '时长',
      'shot.recordSecondsUnit': '{value} 秒',
      'tree.title': 'UI 树',
      'tree.hint': '点一行 = 点击该控件中心点；三角可折叠层级',
      'tree.all': '全部节点',
      'tree.refresh': '刷新 UI 树',
      'tree.loading': '正在读取 UI 树…',
      'tree.empty': '还没有读取 UI 树',
      'tree.noMatch': '没有匹配的节点',
      'tree.truncated': '内容过长，已截断',
      'tree.tap': '点击 ({x}, {y})',
      'tree.expand': '展开子节点',
      'tree.collapse': '收起子节点',
      'logs.title': '日志',
      'logs.crash': '只看崩溃',
      'logs.refresh': '刷新日志',
      'logs.loading': '正在读取日志…',
      'logs.empty': '还没有读取日志',
      'logs.noMatch': '没有匹配的日志行',
      'logs.summary': '{matches} 行匹配 / 扫描 {scanned} 行',
      'empty.title': '没有检测到鸿蒙设备',
      'empty.lead': '用 USB 连接设备并打开「开发者选项 → USB 调试」，或用 hdc 连上无线设备后点重新检测。',
      'empty.step1': '设备上打开「开发者选项」里的 USB 调试',
      'empty.step2': 'USB 连接，或在插件配置中设置 remoteAddress 连接无线设备',
      'empty.step3': '点下面的按钮重新检测',
      'empty.retry': '重新检测',
      'empty.noHdcTitle': '找不到 hdc 客户端',
      'empty.noHdcLead': 'Host 上没找到 hdc。装了 DevEco Studio 或命令行工具的话，检查 DEVECO_SDK_HOME 是否指向它的 sdk 目录；也可以在插件配置的 hdcPath 里直接填 hdc 的绝对路径。',
      'error.retry': '重试',
      'error.devices': '读取设备列表失败',
    }

    const en = {
      panel: 'HarmonyOS device',
      title: 'HarmonyOS device',
      subtitle: 'Live screen, taps and swipes, UI hierarchy and logs over hdc',
      'device.label': 'Device',
      'device.select': 'Select a device',
      'device.refresh': 'Refresh devices',
      'device.none': 'No device selected',
      'device.detected': 'hdc: {path}',
      'action.back': 'Back',
      'action.home': 'Home',
      'action.power': 'Power',
      'action.busy': 'Working…',
      'action.send': 'Type',
      'action.textPlaceholder': 'Type text and press Enter to send it to the focused field',
      'action.textDone': 'Text sent',
      'shot.tapHint': 'Tap the picture to tap the same spot; press and drag to swipe',
      'shot.tapDone': 'Tapped ({x}, {y})',
      'shot.swipeDone': 'Swiped ({x}, {y}) → ({toX}, {toY})',
      'shot.swipeHint': 'Dragging ({x}, {y}) → ({toX}, {toY})',
      'shot.longPressDone': 'Long-pressed ({x}, {y})',
      'shot.edgeReached': 'Reached the edge of the picture',
      'shot.keyDone': 'Sent {key}',
      'shot.size': '{width} × {height} px',
      'shot.error': 'The picture connection dropped; retry to reconnect to the device',
      'shot.live': 'Live picture',
      'shot.starting': 'Connecting to the picture…',
      'shot.snapshot': 'Screenshot',
      'shot.snapshotDone': 'Screenshot saved: {name}',
      'shot.snapshotOpen': 'Open the screenshot',
      'shot.record': 'Record',
      'shot.recording': 'Recording {seconds}s / {total}s',
      'shot.recordDone': 'Recording saved: {name}',
      'shot.recordOpen': 'Open the recording',
      'shot.recordFrames': 'Kept as a frame sequence: {name}',
      'shot.recordSeconds': 'Length',
      'shot.recordSecondsUnit': '{value} s',
      'tree.title': 'UI tree',
      'tree.hint': 'Click a row to tap that control; the caret folds its children',
      'tree.all': 'All nodes',
      'tree.refresh': 'Refresh UI tree',
      'tree.loading': 'Reading the UI tree…',
      'tree.empty': 'The UI tree has not been read yet',
      'tree.noMatch': 'No matching nodes',
      'tree.truncated': 'Content was too long and is truncated',
      'tree.tap': 'Tap ({x}, {y})',
      'tree.expand': 'Expand children',
      'tree.collapse': 'Collapse children',
      'logs.title': 'Logs',
      'logs.crash': 'Crashes only',
      'logs.refresh': 'Refresh logs',
      'logs.loading': 'Reading logs…',
      'logs.empty': 'Logs have not been read yet',
      'logs.noMatch': 'No matching log lines',
      'logs.summary': '{matches} matched / {scanned} scanned',
      'empty.title': 'No HarmonyOS device found',
      'empty.lead': 'Connect a device over USB with USB debugging enabled, or attach a wireless device through hdc, then check again.',
      'empty.step1': 'Enable USB debugging under Developer options on the device',
      'empty.step2': 'Connect by USB, or set remoteAddress in the plugin configuration for a wireless device',
      'empty.step3': 'Press the button below to check again',
      'empty.retry': 'Check again',
      'empty.noHdcTitle': 'hdc client not found',
      'empty.noHdcLead': 'The Host could not find hdc. If DevEco Studio or the command-line tools are installed, check that DEVECO_SDK_HOME points at its sdk directory; otherwise set hdcPath to the client\'s absolute path in the plugin config.',
      'error.retry': 'Retry',
      'error.devices': 'Could not read the device list',
    }

    // ── transport ────────────────────────────────────────────────────────────
    // The Host answers failures with `{error: {code, message}}`, sometimes with
    // a non-2xx status and sometimes with 200. Both are treated as failures so
    // a missing device is never rendered as an empty (but successful) result.

    /** Read the Host's declared error from a decoded body, if it carries one. */
    function describeError(body) {
      if (body === null || typeof body !== 'object') return undefined
      const failure = body.error
      if (failure === undefined || failure === null) return undefined
      if (typeof failure === 'string') return failure
      if (typeof failure.message === 'string' && failure.message !== '') return failure.message
      if (typeof failure.code === 'string' && failure.code !== '') return failure.code
      return JSON.stringify(failure)
    }

    /** The Host's stable failure code from a decoded body, when it carries one. */
    function failureCode(body) {
      const failure = body !== null && typeof body === 'object' ? body.error : undefined
      if (failure === null || typeof failure !== 'object') return undefined
      return typeof failure.code === 'string' && failure.code !== '' ? failure.code : undefined
    }

    /**
     * Ask the Host and throw a failure carrying both the readable text and the
     * stable code.
     *
     * The code is what lets a caller tell "there is no hdc on this machine"
     * from "hdc is fine but no device is connected". Both arrive as a failed
     * request, and showing the install instructions for the second one sends
     * the user to fix something that is not broken.
     */
    async function requestJson(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        throw new Error(`cannot reach the DSH server: ${messageOf(error)}`)
      }
      let body
      try {
        body = await response.clone().json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        const error = new Error(describeError(body) ?? `request failed (HTTP ${response.status})`)
        error.code = failureCode(body)
        throw error
      }
      if (body === undefined) throw new Error('the host returned a non-JSON body')
      const declared = describeError(body)
      if (declared !== undefined) {
        const error = new Error(declared)
        error.code = failureCode(body)
        throw error
      }
      return body
    }

    /** Turn anything thrown into a string a user can read. */
    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message
      return String(error)
    }

    /** Best-effort failure text for a body that is not being read as JSON. */
    async function failureText(response) {
      let body
      try {
        body = await response.clone().json()
      } catch {
        // A dropped connection or a non-JSON body leaves only the status line.
        body = undefined
      }
      const error = new Error(describeError(body) ?? `request failed (HTTP ${response.status})`)
      error.code = failureCode(body)
      return error
    }

    /** Append a query parameter only when it is set, keeping URLs readable. */
    function withQuery(path, params) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== false) query.set(key, String(value))
      }
      const text = query.toString()
      return text === '' ? path : `${path}?${text}`
    }

    /** Clamp an integer into a closed range. */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * How fast to replay the swipe the finger just made, in device pixels per
     * second.
     *
     * The device takes a *velocity*, so this returns one. The pace the gesture was
     * actually drawn at is `distance / elapsed`, clamped into what the device
     * accepts: outside that band `uitest` does not fail, it quietly swaps in its
     * own default, which is exactly how a flick stops feeling like a flick.
     *
     * Measuring from the moment the gesture became a swipe rather than from the
     * press is what keeps a press-then-drag honest: a long hold before moving is
     * not part of the movement, and counting it would replay a deliberate drag at
     * a crawl.
     *
     * @param elapsedMs - how long the dragging part of the gesture took.
     * @param distancePx - how far the swipe travels, in device pixels.
     */
    function swipeVelocity(elapsedMs, distancePx) {
      // Nothing to measure: a zero-length gesture gets the device's own default
      // rather than a division by zero.
      if (!(distancePx > 0)) return SWIPE_DEFAULT_SPEED_PX_PER_S
      if (!Number.isFinite(elapsedMs)) return SWIPE_DEFAULT_SPEED_PX_PER_S
      const elapsed = clamp(elapsedMs, SWIPE_MIN_ELAPSED_MS, SWIPE_MAX_ELAPSED_MS)
      const observed = Math.round((distancePx / elapsed) * 1000)
      return clamp(observed, SWIPE_MIN_SPEED_PX_PER_S, SWIPE_MAX_SPEED_PX_PER_S)
    }

    /** Append a device-pixel sample while keeping only the recent trailing window. */
    function recordGestureSample(samples, point, at) {
      samples.push({ x: point.x, y: point.y, t: at })
      while (samples.length > 2 && at - samples[1].t > TRAILING_VELOCITY_WINDOW_MS) {
        samples.shift()
      }
    }

    /**
     * Compute fallback swipe velocity from the trailing window before release.
     *
     * A slow drag followed by a flick keeps the flick's release speed, while a
     * drag that pauses before lifting stays slow instead of triggering a fling.
     */
    function trailingSwipeVelocity(gesture, end, now) {
      const { start, samples } = gesture
      const fullDist = Math.hypot(end.x - start.x, end.y - start.y)
      const fullElapsed = now - (gesture.swipeStartedAt ?? now)
      if (Array.isArray(samples) && samples.length > 0) {
        let anchorIndex = samples.findIndex((entry) => now - entry.t <= TRAILING_VELOCITY_WINDOW_MS)
        if (anchorIndex < 0) anchorIndex = samples.length - 1
        const anchor = samples[anchorIndex]
        const tailDist = Math.hypot(end.x - anchor.x, end.y - anchor.y)
        const tailElapsed = now - anchor.t
        if (tailDist > 0 && tailElapsed >= 0) {
          return swipeVelocity(tailElapsed, tailDist)
        }
        if (tailElapsed >= TRAILING_VELOCITY_WINDOW_MS && fullDist > 0) {
          return SWIPE_MIN_SPEED_PX_PER_S
        }
        // If pointerup landed on the same device pixel as the last move within
        // a brief release window, use the speed arriving into that last move.
        if (tailDist === 0 && tailElapsed <= 40 && anchorIndex > 0) {
          const prev = samples[anchorIndex - 1]
          const prevDist = Math.hypot(anchor.x - prev.x, anchor.y - prev.y)
          const prevElapsed = anchor.t - prev.t
          if (prevDist > 0 && prevElapsed >= 0) {
            return swipeVelocity(prevElapsed, prevDist)
          }
        }
      }
      return swipeVelocity(fullElapsed, fullDist)
    }

    /**
     * Build the remaining live-touch steps on pointer release so trailing moves
     * and `touchUp` execute in one daemon RPC turn without an HTTP gap before lift-off.
     */
    function buildLiveReleaseSteps(gesture, from, end, now) {
      if (from.x === end.x && from.y === end.y) {
        return [{ action: 'touchUp', x: end.x, y: end.y, delayMs: 0 }]
      }
      const trailing = []
      const anchorTime = gesture.sentAt ?? gesture.swipeStartedAt ?? gesture.pressedAt
      for (const sample of gesture.samples) {
        if (sample.t < anchorTime) continue
        if (now - sample.t > TRAILING_VELOCITY_WINDOW_MS) continue
        if (trailing.length === 0 && sample.x === from.x && sample.y === from.y) continue
        const prev = trailing[trailing.length - 1]
        if (prev !== undefined && prev.x === sample.x && prev.y === sample.y) continue
        trailing.push(sample)
      }
      const last = trailing[trailing.length - 1]
      if (last === undefined || last.x !== end.x || last.y !== end.y) {
        trailing.push({ x: end.x, y: end.y, t: now })
      }
      const tail = trailing.slice(-4)
      const steps = []
      const dist = Math.hypot(end.x - from.x, end.y - from.y)
      const vel = trailingSwipeVelocity(gesture, end, now)
      if (tail.length < 2 && dist >= 8 && vel >= 800) {
        // Moves were coalesced while touchDown was in flight; synthesize a short
        // high-cadence trailing ramp so the device's velocity tracker sees motion
        // right before lift-off instead of a single jump.
        const count = 3
        const spanMs = clamp(Math.round((dist / vel) * 1000), 12, 36)
        const stepDelay = Math.max(4, Math.round(spanMs / count))
        for (let index = 1; index <= count; index += 1) {
          const ratio = index / count
          steps.push({
            action: 'touchMove',
            x: Math.round(from.x + (end.x - from.x) * ratio),
            y: Math.round(from.y + (end.y - from.y) * ratio),
            delayMs: index === 1 ? 0 : stepDelay,
          })
        }
      } else {
        for (let index = 0; index < tail.length; index += 1) {
          const point = tail[index]
          const prev = index === 0 ? undefined : tail[index - 1]
          const delayMs = prev === undefined ? 0 : clamp(Math.round(point.t - prev.t), 0, 25)
          steps.push({ action: 'touchMove', x: point.x, y: point.y, delayMs })
        }
      }
      steps.push({ action: 'touchUp', x: end.x, y: end.y, delayMs: 0 })
      return steps
    }

    /**
     * Read the Host's structured outline, falling back to its flat text.
     *
     * The Host answers `/hdc/uitree` with two views of one dump: `content`, one
     * line per node, and `rows`, the same nodes with their depth. The panel
     * draws `rows` because the hierarchy is the point of a tree view — the flat
     * text reads as a list however it is styled.
     *
     * The fallback is not ceremony: a Host built before `rows` existed still
     * answers with `content`, and a panel that rendered nothing for it would
     * look broken against a plugin copy that is merely older. In that case the
     * tree degrades to one flat row per line, which is exactly what the panel
     * did before.
     *
     * @param body - the decoded `/hdc/uitree` response.
     * @returns rows in dump order; `depth` is 0 for the flat fallback.
     */
    function treeRowsOf(body) {
      const rows = Array.isArray(body?.rows) ? body.rows : undefined
      if (rows !== undefined) {
        return rows
          .filter((row) => row !== null && typeof row === 'object')
          .map((row) => ({
            depth: Number.isFinite(row.depth) && row.depth > 0 ? Math.trunc(row.depth) : 0,
            text: labelOfRow(row),
            tap: isPoint(row.tap) ? { x: row.tap.x, y: row.tap.y } : null,
            hasChildren: row.hasChildren === true,
            clickable: row.clickable === true,
          }))
      }
      return parseTreeRows(body?.content)
    }

    /** Whether a value is a usable device point. */
    function isPoint(value) {
      return value !== null && typeof value === 'object'
        && Number.isFinite(value.x) && Number.isFinite(value.y)
    }

    /**
     * Render one outline row as the line shown to the user.
     *
     * Built from the fields rather than read off the Host's `content` line: the
     * two views must not be able to disagree about which control a row names,
     * and a row still needs text when only `rows` was sent.
     */
    function labelOfRow(row) {
      const label = typeof row.text === 'string' && row.text !== '' ? ` ${JSON.stringify(row.text)}` : ''
      return `${String(row.type ?? '')}${label}`
    }

    /**
     * Split the Host's flat text into clickable rows.
     *
     * The Host renders every node as
     * `Type "label" clickable @ [x,y][wxh] tap (cx, cy)`; the trailing tap point
     * is the only part this panel needs, and a row without it stays a plain
     * line instead of becoming a button that cannot do anything.
     *
     * @param content - the `content` field of `/hdc/uitree`.
     * @returns rows, in dump order.
     */
    function parseTreeRows(content) {
      if (typeof content !== 'string' || content === '') return []
      const rows = []
      for (const line of content.split('\n')) {
        if (line.trim() === '') continue
        const match = /\btap \((-?\d+), (-?\d+)\)\s*$/u.exec(line)
        rows.push({
          depth: 0,
          text: line,
          tap: match === null ? null : { x: Number(match[1]), y: Number(match[2]) },
          hasChildren: false,
          clickable: /\bclickable\b/u.test(line),
        })
      }
      return rows
    }

    /** The Host answers "nothing matched" with a bracketed placeholder line. */
    function isPlaceholder(content) {
      return typeof content !== 'string' || content.trim() === '' || /^\(no /u.test(content.trim())
    }

    /** The file name of a path the Host reported, for a short caption. */
    function nameOf(value) {
      if (typeof value !== 'string' || value === '') return ''
      const parts = value.split(/[\\/]/u)
      return parts[parts.length - 1] === '' ? value : parts[parts.length - 1]
    }

    // ── styles ───────────────────────────────────────────────────────────────
    // A component-owned <style> element: unmounting the panel removes the rules
    // with it, so nothing has to be tracked in `ctx.effect`. Class names carry a
    // `hdci-` prefix because a <style> applies document-wide.
    // Every color is a theme token so light/dark switch with the rest of the UI.

    /**
     * Build a 24x24 SVG data-URI cursor centered at (12, 12).
     *
     * Every pointer state shares the exact same canvas and hotspot so the center
     * target dot never jumps between hover, press, long-press, and drag.
     */
    function cursorUrl(svgBody, fallback) {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>${svgBody}</svg>`
      return `url("data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}") 12 12, ${fallback}`
    }

    const CURSOR_IDLE = cursorUrl(
      "<circle cx='12' cy='12' r='8.5' fill='#111' fill-opacity='0.10' stroke='#111' stroke-opacity='0.42' stroke-width='2.6'/><circle cx='12' cy='12' r='8.5' fill='none' stroke='#fff' stroke-width='1.4'/><circle cx='12' cy='12' r='2.3' fill='#fff' fill-opacity='0.92'/><circle cx='12' cy='12' r='1.3' fill='#111'/>",
      'crosshair',
    )
    const CURSOR_PRESS = cursorUrl(
      "<circle cx='12' cy='12' r='6.5' fill='#2f6fed' fill-opacity='0.22' stroke='#fff' stroke-opacity='0.92' stroke-width='2.8'/><circle cx='12' cy='12' r='6.5' fill='none' stroke='#2f6fed' stroke-width='1.6'/><circle cx='12' cy='12' r='2.2' fill='#fff' fill-opacity='0.95'/><circle cx='12' cy='12' r='1.3' fill='#2f6fed'/>",
      'crosshair',
    )
    const CURSOR_LONG_PRESS = cursorUrl(
      "<circle cx='12' cy='12' r='5.5' fill='#2f6fed' fill-opacity='0.36' stroke='#fff' stroke-opacity='0.95' stroke-width='3'/><circle cx='12' cy='12' r='5.5' fill='none' stroke='#2f6fed' stroke-width='2'/><circle cx='12' cy='12' r='2.2' fill='#fff' fill-opacity='0.95'/><circle cx='12' cy='12' r='1.4' fill='#2f6fed'/>",
      'crosshair',
    )
    const CURSOR_DRAG = cursorUrl(
      "<circle cx='12' cy='12' r='9.5' fill='none' stroke='#fff' stroke-opacity='0.82' stroke-width='2.2'/><circle cx='12' cy='12' r='9.5' fill='none' stroke='#2f6fed' stroke-opacity='0.6' stroke-width='1.2'/><circle cx='12' cy='12' r='5.5' fill='#2f6fed' fill-opacity='0.28' stroke='#fff' stroke-opacity='0.95' stroke-width='2.4'/><circle cx='12' cy='12' r='5.5' fill='none' stroke='#2f6fed' stroke-width='1.5'/><circle cx='12' cy='12' r='2.1' fill='#fff' fill-opacity='0.95'/><circle cx='12' cy='12' r='1.3' fill='#2f6fed'/>",
      'grabbing',
    )

    const STYLE_TEXT = `
.hdci-page{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.6;overflow:hidden}
.hdci-page *,.hdci-page *::before,.hdci-page *::after{box-sizing:border-box}
.hdci-head{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;flex:none;padding:18px 20px 12px}
[data-platform='darwin'] .hdci-head{padding-top:calc(18px + var(--dsh-frame-top-clearance,0px))}
.hdci-heading{display:flex;flex-direction:column;gap:1px;min-width:0;margin-right:auto}
.hdci-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.hdci-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hdci-sub[data-error='true']{color:var(--dsw-alias-state-error-primary)}
.hdci-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hdci-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;font:inherit;font-size:12.5px;line-height:1;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-card-fill);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out),border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),color var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.hdci-btn:hover:not(:disabled){background:var(--dsw-alias-card-fill-hover);border-color:var(--dsw-alias-border-l4)}
.hdci-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.hdci-btn:disabled{opacity:.5;cursor:default}
.hdci-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.hdci-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.hdci-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:transparent}
.hdci-btn-flat{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:0 8px}
.hdci-btn-flat:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:transparent;color:var(--dsw-alias-label-primary)}
.hdci-select{height:30px;max-width:280px;padding:0 8px;font:inherit;font-size:12.5px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.hdci-select-narrow{max-width:96px;flex:none}
.hdci-select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.hdci-body{flex:1;min-height:0;display:flex;gap:14px;padding:0 20px 20px}
.hdci-main{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;flex:1 1 56%}
.hdci-side{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;flex:1 1 44%}
.hdci-stage{position:relative;flex:1;min-height:160px;display:flex;align-items:center;justify-content:center;padding:10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
/* No border on the image itself: the tap→device-pixel math divides by the
   element's own box, so a border would offset the drawn picture from the box the
   press is measured against. The stage around it carries the visual edge.
   The cursor is drawn as a touch-ring target rather than the platform's
   crosshair or grabbing fist: a haloed center dot marks the exact point that
   becomes the device coordinate so it stays visible over both light and dark
   apps, contracting on press/long-press and expanding a concentric guide ring
   during drag without jumping hotspots. touch-action:none keeps a press from
   turning into a page scroll or a pinch, which would swallow the tap. */
.hdci-shot{display:block;width:auto;height:auto;max-width:100%;max-height:100%;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);cursor:${CURSOR_IDLE};touch-action:none;-webkit-user-select:none;user-select:none}
.hdci-shot:active,.hdci-stage[data-pressing='true'] .hdci-shot{cursor:${CURSOR_PRESS}}
.hdci-stage[data-longpress='true'] .hdci-shot{cursor:${CURSOR_LONG_PRESS}}
.hdci-ripple{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;pointer-events:none;border:2px solid var(--dsw-alias-state-business-primary,#2f6fed);background:rgba(47,111,237,.22);box-shadow:0 0 0 1px rgba(255,255,255,.35) inset;animation:hdci-ripple 420ms var(--ds-ease-out,ease-out) forwards}
@keyframes hdci-ripple{0%{transform:scale(.55);opacity:.95}100%{transform:scale(1.6);opacity:0}}
@media (prefers-reduced-motion:reduce){.hdci-ripple{animation:none;opacity:.85}}
/* The live swipe: a line from where the press started to where the finger is,
   with a dot at each end. It is drawn in stage pixels and, like the tap mark,
   never takes a pointer event — the gesture that drives it must keep receiving
   the moves that redraw it. The colors are literals rather than theme tokens for
   the same reason the tap mark uses them: this sits on top of an arbitrary app's
   own colors, and a theme token chosen for the panel's background can vanish
   against a screenshot of a white or a black app. */
.hdci-drag{position:absolute;inset:0;overflow:visible;pointer-events:none}
.hdci-drag-line{stroke:rgba(47,111,237,.9);stroke-width:2.5;stroke-linecap:round;stroke-dasharray:7 5}
.hdci-drag-dot{fill:rgba(47,111,237,.9);stroke:rgba(255,255,255,.9);stroke-width:2}
.hdci-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}
.hdci-placeholder{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.hdci-placeholder-title{font-size:13px;color:var(--dsw-alias-label-secondary)}
.hdci-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
/* The gesture hint sits directly under the picture, where someone wondering
   whether the picture can be dragged is already looking. Secondary text rather
   than tertiary, because it is the only place the swipe is advertised. */
.hdci-hint{display:flex;align-items:center;gap:6px;flex:none;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.hdci-hint-grip{font-size:13px;color:var(--dsw-alias-label-tertiary);letter-spacing:-2px}
.hdci-bar-edge{color:var(--dsw-alias-label-tertiary)}
/* While a gesture is in progress the stage says so: a business-coloured edge and
   a concentric active touch-ring cursor, so "if I let go now it swipes" is
   visible on the picture itself without losing center-dot precision. */
.hdci-stage[data-dragging='true']{border-color:var(--dsw-alias-state-business-primary)}
.hdci-stage[data-dragging='true'] .hdci-shot{cursor:${CURSOR_DRAG};-webkit-user-select:none;user-select:none}
.hdci-bar-note{color:var(--dsw-alias-state-success-primary)}
.hdci-bar-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.hdci-artifacts{display:flex;flex-direction:column;gap:4px;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.hdci-artifact{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.hdci-artifact-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.hdci-artifact-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}
.hdci-link{flex:none;color:var(--dsw-alias-state-business-primary);text-decoration:none;border-radius:var(--dsw-radius-xs)}
.hdci-link:hover{text-decoration:underline}
.hdci-link:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.hdci-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}
.hdci-textrow{display:flex;align-items:center;gap:8px;flex:none;margin-top:8px}
.hdci-textinput{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 10px;font:inherit;font-size:12.5px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.hdci-textinput::placeholder{color:var(--dsw-alias-label-tertiary)}
.hdci-textinput:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-color:transparent}
.hdci-textinput:disabled{opacity:.5;cursor:default}
.hdci-card{display:flex;flex-direction:column;min-height:0;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.hdci-card[data-open='true']{flex:1 1 0}
.hdci-card[data-open='false']{flex:none}
.hdci-card-head{display:flex;align-items:center;gap:6px;flex:none;padding:6px 8px 6px 4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hdci-card[data-open='false'] .hdci-card-head{border-bottom-color:transparent}
.hdci-card-toggle{display:inline-flex;align-items:center;gap:6px;min-width:0;margin-right:auto;padding:4px 6px;font:inherit;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);background:transparent;border:0;border-radius:var(--dsw-radius-xs);cursor:pointer}
.hdci-card-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hdci-card-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.hdci-caret{display:inline-block;width:10px;color:var(--dsw-alias-label-tertiary);transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.hdci-card[data-open='true'] .hdci-caret{transform:rotate(90deg)}
.hdci-card-count{font-weight:400;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hdci-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.hdci-check input{margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.hdci-card-body{flex:1;min-height:0;overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.hdci-tree{display:flex;flex-direction:column;padding:4px}
.hdci-treerow{display:flex;align-items:flex-start;gap:2px;width:100%;padding:3px 6px 3px 0;font-family:var(--ds-font-family-code);font-size:11.5px;line-height:1.55;text-align:left;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary)}
.hdci-treerow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hdci-treecaret{flex:none;width:14px;height:17px;padding:0;font:inherit;font-size:8px;line-height:17px;text-align:center;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
button.hdci-treecaret:hover{color:var(--dsw-alias-label-primary)}
button.hdci-treecaret:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.hdci-treerow-body{flex:1;min-width:0;padding:0;font:inherit;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:inherit}
button.hdci-treerow-body{color:var(--dsw-alias-label-primary);cursor:pointer}
button.hdci-treerow-body:hover{color:var(--dsw-alias-state-business-primary)}
button.hdci-treerow-body:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}
.hdci-treedot{color:var(--dsw-alias-state-business-primary);margin-left:5px}
.hdci-logs{margin:0;padding:8px 10px;font-family:var(--ds-font-family-code);font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.hdci-logs[data-empty='true']{color:var(--dsw-alias-label-tertiary)}
.hdci-note-inline{padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.hdci-error-inline{padding:8px 10px;font-size:12px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.hdci-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px 24px;text-align:center;min-height:0;overflow:auto}
.hdci-empty-art{color:var(--dsw-alias-illustration-detail)}
.hdci-empty-title{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}
.hdci-empty-lead{max-width:460px;margin:0;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.hdci-empty-steps{margin:0;padding-left:18px;text-align:left;font-size:12.5px;line-height:1.8;color:var(--dsw-alias-label-secondary)}
.hdci-errorbox{max-width:520px;display:flex;flex-direction:column;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
@media (max-width:900px){
.hdci-body{flex-direction:column;overflow:auto}
.hdci-main,.hdci-side{flex:none}
.hdci-side{min-height:280px}
.hdci-stage{min-height:240px}
}
`

    // ── small pieces ─────────────────────────────────────────────────────────

    /** One of the shared pill buttons; `key` keeps list children stable. */
    function actionButton(key, label, onClick, options) {
      const { variant = 'default', disabled = false, title, expanded, controls } = options ?? {}
      return h(
        'button',
        {
          key,
          type: 'button',
          className: variant === 'flat' ? 'hdci-btn hdci-btn-flat' : variant === 'primary' ? 'hdci-btn hdci-btn-primary' : 'hdci-btn',
          onClick,
          disabled,
          title: title ?? label,
          'aria-expanded': expanded,
          'aria-controls': controls,
        },
        label,
      )
    }

    /** Sidebar glyph. `currentColor` lets the sidebar tint it when active. */
    function HdcPanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 4.25, y: 1.5, width: 7.5, height: 13, rx: 2 }),
        h('circle', { cx: 8, cy: 6.6, r: 1.3 }),
        h('path', { d: 'M6.9 12.5h2.2' }),
      )
    }

    /** The illustration the empty state shows when no device is attached. */
    function EmptyArtwork() {
      return h(
        'svg',
        {
          width: 96,
          height: 96,
          viewBox: '0 0 96 96',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          className: 'hdci-empty-art',
          focusable: 'false',
        },
        h('rect', { x: 30, y: 12, width: 36, height: 66, rx: 8, opacity: 0.55 }),
        h('path', { d: 'M40 72h16', opacity: 0.55 }),
        h('path', { d: 'M12 46a18 18 0 0 1 18-18', opacity: 0.35 }),
        h('path', { d: 'M12 58a30 30 0 0 1 30-30', opacity: 0.2 }),
      )
    }

    // ── the panel page ───────────────────────────────────────────────────────

    /**
     * Full-page device control panel.
     *
     * Rendered by the `main` slot, which unmounts it whenever another panel is
     * selected, so every resource (poll timer, abort controller, object URL) is
     * tied to this component's lifetime and released in its cleanup.
     */
    function HdcPanelPage(props) {
      // The renderer hands a namespace-bound `t` seat to any entry that declares
      // `locale`. Fall back to the key rather than throwing: a crash would blank
      // the whole slot entry.
      const t = typeof props?.t === 'function' ? props.t : (key) => key

      const [devices, setDevices] = useState(null)
      const [devicesError, setDevicesError] = useState(null)
      const [devicesErrorCode, setDevicesErrorCode] = useState(null)
      const [devicesLoading, setDevicesLoading] = useState(true)
      const [hdcPath, setHdcPath] = useState(null)
      const [device, setDevice] = useState(null)

      const [inputBusy, setInputBusy] = useState(false)
      const [inputError, setInputError] = useState(null)
      const [note, setNote] = useState(null)
      const [textDraft, setTextDraft] = useState('')

      const [treeOpen, setTreeOpen] = useState(false)
      const [tree, setTree] = useState(null)
      const [treeLoading, setTreeLoading] = useState(false)
      const [treeError, setTreeError] = useState(null)
      const [showAllNodes, setShowAllNodes] = useState(false)
      // Folded row indexes by their position in the dump. It survives a refresh
      // on purpose: re-reading the same screen is what the refresh button is
      // for, and folding the tree again after each one would be busywork.
      const [collapsedRows, setCollapsedRows] = useState(NO_COLLAPSED)

      const [logsOpen, setLogsOpen] = useState(false)
      const [logs, setLogs] = useState(null)
      const [logsLoading, setLogsLoading] = useState(false)
      const [logsError, setLogsError] = useState(null)
      const [crashOnly, setCrashOnly] = useState(true)

      // Each UI-tree and log read takes a ticket, and only the newest ticket may
      // write state. Without it a dump started on device A lands after the user
      // switched to B, and the panel then shows A's controls while every row
      // taps B — a tap aimed at a control that is not on the screen being
      // looked at. The refs are declared here, above every effect that bumps
      // them, so a device switch can retire a read mid-flight.
      const treeTicketRef = useRef(0)
      const logsTicketRef = useRef(0)

      const queueRef = useRef({ device: null, generation: 0, items: [], running: false, controller: null })

      /**
       * Abandon everything queued and in flight.
       *
       * Called by the device-switch effect and by unmount. Bumping the
       * generation is what makes it stick: a `drainQueue` loop that is already
       * awaiting a fetch wakes up to a generation it no longer owns and stops
       * instead of sending the rest.
       */
      const resetQueue = useCallback((reason) => {
        const queue = queueRef.current
        queue.generation += 1
        queue.items = []
        const controller = queue.controller
        queue.controller = null
        queue.device = null
        setInputBusy(false)
        if (controller !== null) controller.abort(reason)
      }, [])

      // ── devices ────────────────────────────────────────────────────────────

      const loadDevices = useCallback(async () => {
        setDevicesLoading(true)
        try {
          const body = await requestJson('/hdc/devices')
          const list = Array.isArray(body?.devices) ? body.devices.filter((entry) => typeof entry === 'string') : []
          setHdcPath(typeof body?.hdcPath === 'string' && body.hdcPath !== '' ? body.hdcPath : null)
          setDevices(list)
          setDevicesError(null)
          setDevicesErrorCode(null)
          // Keep the current pick when it is still attached; otherwise fall to
          // the first device so the panel is usable immediately after plugging in.
          setDevice((current) => (current !== null && list.includes(current) ? current : list[0] ?? null))
        } catch (error) {
          setDevicesError(messageOf(error))
          // The code distinguishes "no hdc on this machine" from "no device is
          // attached"; only the first one warrants the install instructions.
          setDevicesErrorCode(typeof error?.code === 'string' ? error.code : null)
          setDevices((current) => current ?? NO_DEVICES)
        } finally {
          setDevicesLoading(false)
        }
      }, [])

      useEffect(() => {
        loadDevices()
      }, [loadDevices])

      // ── live picture ───────────────────────────────────────────────────────
      //
      // The Host streams frames as `multipart/x-mixed-replace`, which a plain
      // <img src> renders natively: the browser replaces the picture each time a
      // part arrives. There is no polling and no blob URL here — the whole
      // capture loop lives on the Host, and the panel holds one <img>.
      //
      // `streamNonce` is the whole re-open mechanism: an <img> keeps its current
      // source until the element is replaced, so switching device or retrying a
      // failed stream bumps the nonce, remounting the element with a fresh one.
      //
      // An MJPEG part fires no event after the first one, so the panel cannot
      // count frames. What it can show is what the picture itself reports: its
      // decoded size, and whether it has painted at all.

      // Tap feedback: a mark at each pressed point, so a press is acknowledged
      // the instant it happens instead of after the device's ~0.4 s reply. The
      // picture itself cannot show it sooner — the next frame is what carries
      // the device's own reaction.
      //
      // The marks live in a ref as well as in state: the ref is what the sweep
      // timer reads, so scheduling never depends on a state update having been
      // applied yet.
      const [ripples, setRipples] = useState(NO_MARKS)
      const marksRef = useRef([])
      const markSweepRef = useRef(null)
      const rippleIdRef = useRef(0)

      // The gesture in progress, if any. A press is *not* sent on the way down
      // any more: until it either lifts near where it started (a tap) or travels
      // past the threshold (a swipe), what the user meant is not known yet. The
      // ref holds it because pointermove fires far more often than React can
      // usefully paint, and only a coarse summary of the drag goes to state.
      const gestureRef = useRef(null)
      const gestureSeqRef = useRef(0)
      // Whether the current device supports live touchDown/touchMove/touchUp
      // streaming over the uitest daemon (`null` = untested, `true` = active,
      // `false` = unavailable, fall back to swipe on release).
      const liveTouchRef = useRef(null)

      // The swipe being drawn: a line from where the press started to where the
      // finger is now, in stage pixels, so the user can see the gesture before
      // committing it. `null` while no drag is in progress.
      const [drag, setDrag] = useState(null)
      // Current press state on the picture (`null` | 'pressing' | 'longpress')
      // so the cursor ring can contract while held and emphasize when the
      // long-press threshold is reached.
      const [pressState, setPressState] = useState(null)
      const longPressTimerRef = useRef(null)

      const clearLongPressTimer = useCallback(() => {
        if (longPressTimerRef.current !== null) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
        }
      }, [])

      /**
       * The pending frame that will paint the latest drag position.
       *
       * `pointermove` fires far faster than the screen refreshes — a 120 Hz
       * trackpad or a pen reports several positions per painted frame — and each
       * one used to call `setDrag`, so the panel re-rendered once per event while
       * only the last position before a repaint could ever be seen. Coalescing to
       * one write per animation frame keeps the drawn line on the finger and
       * stops the rest of the render from stealing frames from the stream.
       *
       * The position is kept in a ref rather than in the callback's closure so the
       * scheduled frame always paints the newest point, whatever arrived after it
       * was requested.
       */
      const dragFrameRef = useRef(null)
      const pendingDragRef = useRef(null)

      /** Drop any frame that has not run yet, and forget what it would have drawn. */
      const cancelDragFrame = useCallback(() => {
        // Guarded rather than assumed: an environment without
        // `requestAnimationFrame` also has no `cancelAnimationFrame`, and the
        // fallback path above never sets an id there — but a page that lost the
        // API between frames must still be able to end a gesture.
        if (dragFrameRef.current !== null) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(dragFrameRef.current)
          dragFrameRef.current = null
        }
        pendingDragRef.current = null
      }, [])

      /**
       * Queue one drag position for the next animation frame.
       *
       * Falls back to writing immediately when the environment has no
       * `requestAnimationFrame` (an offline harness, or a hidden page), so the
       * line never silently stops tracking because a browser API is absent.
       */
      const queueDrag = useCallback((next) => {
        pendingDragRef.current = next
        if (dragFrameRef.current !== null) return
        if (typeof requestAnimationFrame !== 'function') {
          pendingDragRef.current = null
          setDrag(next)
          return
        }
        dragFrameRef.current = requestAnimationFrame(() => {
          dragFrameRef.current = null
          const pending = pendingDragRef.current
          pendingDragRef.current = null
          if (pending !== null) setDrag(pending)
        })
      }, [])

      const [streamNonce, setStreamNonce] = useState(0)
      const [streamError, setStreamError] = useState(null)
      const [streamReady, setStreamReady] = useState(false)
      const [frameSize, setFrameSize] = useState(null)

      const restartStream = useCallback(() => {
        liveTouchRef.current = null
        setStreamError(null)
        setStreamReady(false)
        setFrameSize(null)
        setStreamNonce((nonce) => nonce + 1)
      }, [])

      // ── screenshot and recording ───────────────────────────────────────────

      const [captureBusy, setCaptureBusy] = useState(false)
      const [captureNote, setCaptureNote] = useState(null)
      const [recordSeconds, setRecordSeconds] = useState(10)
      const [recordBusy, setRecordBusy] = useState(false)
      const [recordStartedAt, setRecordStartedAt] = useState(null)
      const [recordNow, setRecordNow] = useState(0)
      const [recordNote, setRecordNote] = useState(null)

      // While a recording runs, its elapsed time ticks in the button. The Host
      // is the authority on when it ends; this counter only paints the wait.
      useEffect(() => {
        if (recordStartedAt === null) return undefined
        const timer = setInterval(() => setRecordNow(Date.now()), 250)
        return () => clearInterval(timer)
      }, [recordStartedAt])

      /** Save the current frame at device resolution. */
      const takeSnapshot = useCallback(async () => {
        if (device === null || captureBusy) return
        setCaptureBusy(true)
        setCaptureNote(null)
        try {
          const body = await requestJson('/hdc/capture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device }),
          })
          setCaptureNote({
            text: t('shot.snapshotDone', { name: nameOf(body?.savedPath) }),
            href: typeof body?.artifactId === 'string' ? `/hdc/artifact/${body.artifactId}` : null,
            label: t('shot.snapshotOpen'),
          })
        } catch (error) {
          setCaptureNote({ text: messageOf(error), href: null })
        } finally {
          setCaptureBusy(false)
        }
      }, [device, captureBusy, t])

      /**
       * Record for the selected number of seconds.
       *
       * The request is held open for the whole recording: the Host captures
       * frames until the deadline and answers when the mp4 exists. A stop
       * therefore aborts the request, which makes the Host kill its capture
       * loop and discard the partial file — the same thing that happens when
       * the page is closed mid-recording.
       */
      const recordAbortRef = useRef(null)

      const startRecording = useCallback(async () => {
        if (device === null || recordBusy) return
        const controller = new AbortController()
        recordAbortRef.current = controller
        setRecordBusy(true)
        setRecordNote(null)
        setRecordStartedAt(Date.now())
        setRecordNow(Date.now())
        try {
          const body = await requestJson('/hdc/record', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device, seconds: recordSeconds }),
            signal: controller.signal,
          })
          const name = nameOf(body?.savedPath)
          // A frame sequence is a directory, and the artifact route answers one
          // with a JSON listing rather than a file. Offering "open the recording"
          // for it hands the user a JSON document and no video, so the sequence
          // reports where it was kept and nothing else.
          const isVideo = body?.kind !== 'frames'
          setRecordNote({
            text: isVideo ? t('shot.recordDone', { name }) : t('shot.recordFrames', { name }),
            href: isVideo && typeof body?.artifactId === 'string' ? `/hdc/artifact/${body.artifactId}` : null,
            label: t('shot.recordOpen'),
            detail: typeof body?.note === 'string' ? body.note : null,
          })
        } catch (error) {
          // An abort is the user's own stop, not a failure to report in red.
          setRecordNote(controller.signal.aborted ? null : { text: messageOf(error), href: null })
        } finally {
          recordAbortRef.current = null
          setRecordBusy(false)
          setRecordStartedAt(null)
        }
      }, [device, recordBusy, recordSeconds, t])

      const stopRecording = useCallback(() => {
        const controller = recordAbortRef.current
        if (controller !== null) controller.abort()
      }, [])

      // Switching devices invalidates everything that came from the old one. The
      // stream re-opens on its own: `renderStage` keys the <img> by device, so
      // the old element unmounts and the browser closes the old connection.
      useEffect(() => {
        // A read still in flight for the previous device must not land at all,
        // so its ticket is retired here rather than only at the next read.
        treeTicketRef.current += 1
        logsTicketRef.current += 1
        setTree(null)
        setTreeError(null)
        setLogs(null)
        setLogsError(null)
        setNote(null)
        setInputError(null)
        setCaptureNote(null)
        setRecordNote(null)
        setStreamReady(false)
        setStreamError(null)
        setFrameSize(null)
        // Marks on the old picture are pixels on a screen that is no longer
        // shown; leaving them would place them on the new device's picture.
        marksRef.current = []
        setRipples(NO_MARKS)
        // A drag in progress was measured against the old picture, so its
        // coordinates no longer name anywhere on the new one. A frame already
        // queued would repaint it, so the queued frame goes first.
        gestureRef.current = null
        liveTouchRef.current = null
        cancelDragFrame()
        clearLongPressTimer()
        setPressState(null)
        setDrag(null)
        if (markSweepRef.current !== null) {
          clearTimeout(markSweepRef.current)
          markSweepRef.current = null
        }
        // Inputs already queued for the previous device must not be delivered:
        // they were aimed at a screen the user is no longer looking at.
        resetQueue('device changed')
      }, [device, resetQueue, clearLongPressTimer])

      // Unmount: no timer or in-flight request survives this.
      useEffect(() => () => {
        const controller = recordAbortRef.current
        if (controller !== null) controller.abort()
        clearLongPressTimer()
        // The sweep timer holds a state setter; firing it after unmount would
        // warn and keep the closure alive.
        if (markSweepRef.current !== null) {
          clearTimeout(markSweepRef.current)
          markSweepRef.current = null
        }
        // Leaving the panel must stop queued input too: a backlog of taps would
        // otherwise land on the device after the user has gone elsewhere.
        resetQueue('the panel was closed')
      }, [resetQueue, clearLongPressTimer])

      // ── input ──────────────────────────────────────────────────────────────

      /** Send one device input. The picture catches up on its own, from the stream. */
      /**
       * Serialise device input, preserving order and never dropping a request.
       *
       * One tap costs the device ~0.4 s, and the panel used to refuse a second
       * one while the first was in flight. Two fast taps therefore acted like
       * one, which reads as the picture not following the finger. A queue fixes
       * that: every tap is delivered, in the order it was made, and the buttons
       * stay responsive because only the *device* work is serialised.
       *
       * The queue belongs to one device *and* one generation. A switch or an
       * unmount increments the generation, drops what is still queued and aborts
       * the request in flight, because a tap made against the previous screen
       * must not be delivered after the user has moved on — an input is a real
       * change on a real device, not a request whose result can be ignored.
       *
       * The generation is also checked before each send and before any state is
       * written, so a reply that arrives late cannot paint the old device's
       * outcome over the new device's panel.
       */
      const drainQueue = useCallback(async () => {
        const queue = queueRef.current
        if (queue.running) return
        queue.running = true
        const generation = queue.generation
        try {
          while (queue.items.length > 0 && generation === queue.generation) {
            const item = queue.items.shift()
            item.onDispatch?.()
            const controller = new AbortController()
            queue.controller = controller
            try {
              await requestJson('/hdc/input', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ device: item.device, ...item.payload }),
                signal: controller.signal,
              })
              // Abandoned while this was in flight: say nothing, because the
              // panel on screen is no longer the one that asked.
              if (generation !== queue.generation) return
              item.onSuccess?.()
              if (item.done !== undefined) setNote(item.done)
              setInputError(null)
            } catch (error) {
              if (generation !== queue.generation) return
              // Fall back to single-shot swipe both when the device has no
              // uitest daemon (503 HDC_DAEMON_UNAVAILABLE) and when the Host
              // process itself predates live touch actions (400 HDC_BAD_ARGS).
              if (
                (error?.code === 'HDC_DAEMON_UNAVAILABLE' || error?.code === 'HDC_BAD_ARGS')
                && typeof item.onUnavailable === 'function'
              ) {
                if (item.gestureId !== undefined) {
                  queue.items = queue.items.filter((queued) => queued.gestureId !== item.gestureId)
                }
                item.onUnavailable(error)
                continue
              }
              setNote(null)
              setInputError(messageOf(error))
            } finally {
              if (queue.controller === controller) queue.controller = null
            }
          }
        } finally {
          queue.running = false
          // Only the generation that owns the panel may clear the busy flag.
          if (generation === queue.generation) setInputBusy(false)
        }
      }, [])

      const sendInput = useCallback(
        (payload, done, options) => {
          if (device === null) return
          const queue = queueRef.current
          if (queue.device !== device) {
            // A queued item carries the device it was made against, so a switch
            // can never reinterpret one for the new device.
            queue.device = device
            queue.items = []
          }
          const gestureId = options?.gestureId
          // Coalesce consecutive queued touchMove events for the same gesture so
          // a fast pointer never builds up a backlog of stale intermediate points.
          if (payload.action === 'touchMove' && gestureId !== undefined) {
            const last = queue.items[queue.items.length - 1]
            if (
              last !== undefined
              && last.device === device
              && last.gestureId === gestureId
              && last.payload.action === 'touchMove'
            ) {
              last.payload = payload
              last.done = done
              last.onDispatch = options?.onDispatch
              return
            }
          }
          queue.items.push({
            payload,
            done,
            device,
            gestureId,
            onDispatch: options?.onDispatch,
            onSuccess: options?.onSuccess,
            onUnavailable: options?.onUnavailable,
          })
          setInputBusy(true)
          drainQueue()
        },
        [device, drainQueue],
      )

      /**
       * Prune expired tap marks, and re-arm while any mark is still alive.
       *
       * A single fixed-delay timer would strand a mark made just before it fired:
       * the cutoff would spare it, the timer would clear itself, and nothing would
       * ever remove that mark — it would stay on the picture until the next tap.
       * Re-arming for the oldest survivor's remaining time keeps the list bounded
       * and leaves no mark behind, while still being one timer for the whole list.
       */
      const sweepMarks = useCallback(() => {
        const now = Date.now()
        const alive = marksRef.current.filter((entry) => now - entry.at < MARK_LIFETIME_MS)
        marksRef.current = alive
        setRipples(alive.slice())
        if (alive.length === 0) {
          markSweepRef.current = null
          return
        }
        const oldest = alive.reduce((earliest, entry) => (entry.at < earliest.at ? entry : earliest), alive[0])
        // At least 1 ms, so a zero delay cannot spin.
        const wait = Math.max(1, MARK_LIFETIME_MS - (now - oldest.at))
        markSweepRef.current = setTimeout(sweepMarks, wait)
      }, [])

      /**
       * Map a position on the <img> to device pixels.
       *
       * The mapping is `(pointer - box.left) / box.width * naturalWidth`, then
       * floored, *not rounded*. `naturalWidth` is the capture's own pixel count
       * and the Host captures at device resolution, so the ratio is the exact
       * display→device scale to undo. Flooring turns the scaled position into the
       * index of the pixel it landed in; rounding instead credits the position to
       * whichever pixel center is nearer, which biases every coordinate by up to
       * half a pixel and can reach a pixel past the edge at the far side. The
       * clamp then keeps a point on the very border inside the screen.
       *
       * Per axis on purpose: it stays correct even if a layout ever stretches the
       * two axes differently, and it costs one division each.
       *
       * @returns device-space `{x, y}`, or `null` when there is nothing to map
       *   against yet (no decoded frame, or a picture laid out at zero size).
       */
      function toDevicePoint(image, clientX, clientY) {
        const width = image.naturalWidth
        const height = image.naturalHeight
        // No frame has decoded yet: there is nothing to map against, and the
        // overlay covers this case anyway.
        if (width === 0 || height === 0) return null
        const box = image.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return null
        return {
          x: clamp(Math.floor(((clientX - box.left) / box.width) * width), 0, width - 1),
          y: clamp(Math.floor(((clientY - box.top) / box.height) * height), 0, height - 1),
        }
      }

      /**
       * Where a pointer sits inside the stage, in stage pixels.
       *
       * The mark is positioned in *stage* pixels, not percentages. The stage is
       * the containing block for an absolutely positioned child, and the picture
       * is usually narrower than the stage (a tall phone screen in a wide panel),
       * so a percentage of the picture landed the mark well outside the picture
       * whenever the two differed.
       *
       * An absolutely positioned child is laid out against the *padding* box of
       * its containing block, so the border has to come off the stage origin.
       * `clientLeft`/`clientTop` are the border widths the browser already laid
       * out; reading them costs nothing, while `getComputedStyle` forces a style
       * recalc on every move — during a ~5 fps stream repaint that is the one
       * avoidable cost in this path.
       */
      function toStagePoint(stage, clientX, clientY) {
        const stageBox = stage.getBoundingClientRect()
        return {
          left: clientX - stageBox.left - stage.clientLeft,
          top: clientY - stageBox.top - stage.clientTop,
        }
      }

      /**
       * Where a device point is drawn inside the stage.
       *
       * The inverse of `toDevicePoint`, and the reason the drag line is drawn from
       * the *device* point rather than from the raw pointer position: once the
       * pointer leaves the picture the device point is clamped to the edge, so
       * drawing the line at the pointer would run past the edge while the status
       * line already reported the clamped coordinate. The line has to stop where
       * the swipe is actually going to stop.
       */
      function stagePointOfDevice(image, point, stage) {
        const box = image.getBoundingClientRect()
        const width = image.naturalWidth
        const height = image.naturalHeight
        const imageBox = toStagePoint(stage, box.left, box.top)
        return {
          left: imageBox.left + ((point.x + 0.5) / width) * box.width,
          top: imageBox.top + ((point.y + 0.5) / height) * box.height,
        }
      }

      /**
       * Acknowledge a press immediately with a mark at that point.
       *
       * The device's own reply arrives on a later frame, which can be 400 ms
       * away, and a gesture with no feedback until then reads as a missed one.
       *
       * One timer for the whole list, armed only when none is pending: a burst
       * would otherwise schedule one timer each, and every one of them would
       * rebuild the array.
       */
      function markPoint(left, top) {
        rippleIdRef.current += 1
        const id = rippleIdRef.current
        marksRef.current.push({ id, at: Date.now(), left: `${left}px`, top: `${top}px` })
        setRipples(marksRef.current.slice())
        if (markSweepRef.current === null) {
          markSweepRef.current = setTimeout(sweepMarks, MARK_LIFETIME_MS)
        }
        return id
      }

      /**
       * Move an existing mark to where the gesture actually ended.
       *
       * A mark is made on the way down so the press is acknowledged at once. When
       * the gesture turns out to be a tap a few pixels away, leaving the mark at
       * the press point would contradict the coordinate the device was given, so
       * it follows the finger instead of a second mark appearing beside it.
       */
      function moveMark(id, left, top) {
        const mark = marksRef.current.find((entry) => entry.id === id)
        if (mark === undefined) return
        mark.left = `${left}px`
        mark.top = `${top}px`
        setRipples(marksRef.current.slice())
      }
      /**
       * Begin a gesture. Nothing is sent yet.
       *
       * `pointerdown` rather than `click`: a click only exists once the button
       * comes back up, and it never arrives for a touch press that drifts. But a
       * press alone is also not yet a tap — it may be the start of a swipe — so
       * this only records where and when it started. `pointerup` decides which
       * gesture it turned out to be.
       *
       * `setPointerCapture` is what makes the rest of the gesture arrive here
       * even after the pointer leaves the picture, which is the normal case for
       * a swipe that runs off the edge. Without it the browser stops reporting
       * `pointermove` at the boundary and the swipe would be truncated — or, for
       * a touch, cancelled outright.
       */
      /** Send a fallback single-shot swipe when live daemon touch is unavailable. */
      function sendFallbackSwipe(gesture, end, at) {
        const { start } = gesture
        if (end.x === start.x && end.y === start.y) {
          sendInput({ action: 'click', x: end.x, y: end.y }, t('shot.tapDone', { x: end.x, y: end.y }))
          return
        }
        sendInput(
          {
            action: 'swipe',
            x: start.x,
            y: start.y,
            to_x: end.x,
            to_y: end.y,
            // Replay the gesture at the trailing speed it was made at, as a
            // velocity in pixels per second — which is what `uitest` takes.
            velocity: trailingSwipeVelocity(gesture, end, at),
          },
          t('shot.swipeDone', { x: start.x, y: start.y, toX: end.x, toY: end.y }),
        )
      }

      /** Handle live daemon unavailability by switching this gesture to fallback swipe mode. */
      function fallbackFromLiveTouch(gesture) {
        liveTouchRef.current = false
        gesture.live = false
        gesture.touchDownFailed = true
        if (gesture.endedPoint !== null) {
          sendFallbackSwipe(gesture, gesture.endedPoint, gesture.endedAt ?? Date.now())
          return
        }
        if (gestureRef.current === gesture) {
          setDrag((current) => (current === null ? null : { ...current, live: false }))
        }
      }

      function onShotPointerDown(event) {
        // A gesture is an intent, not a state to sample. Dropping one because the
        // previous request is still in flight is what makes a double tap or a fast
        // second tap vanish, so they queue instead (see `sendInput`).
        if (device === null) return
        // A pen's eraser button or a middle-click is not a gesture.
        if (typeof event.button === 'number' && event.button !== 0) return
        const image = event.currentTarget
        const start = toDevicePoint(image, event.clientX, event.clientY)
        // No decoded frame yet: there is nothing to map against.
        if (start === null) return
        const stage = image.parentElement
        if (stage === null) return

        const now = Date.now()
        gestureSeqRef.current += 1
        const gestureId = gestureSeqRef.current
        gestureRef.current = {
          id: gestureId,
          pointerId: event.pointerId,
          image,
          stage,
          startClientX: event.clientX,
          startClientY: event.clientY,
          start,
          lastPoint: start,
          lastSentPoint: null,
          sentPoint: null,
          sentAt: null,
          // A mouse is held to a tighter standard than a fingertip: it does not
          // wobble, so a slip that would be normal for touch is a deliberate drag
          // for a mouse. Anything that is not a mouse (touch, pen) gets the
          // forgiving value.
          threshold: event.pointerType === 'mouse' ? SWIPE_THRESHOLD_MOUSE_PX : SWIPE_THRESHOLD_TOUCH_PX,
          // The furthest the pointer ever gets from where it went down. The
          // gesture is judged on this rather than on where it was released: a
          // press that travels out and comes back would otherwise look like a tap
          // and click where the user meant to scroll.
          maxTravel: 0,
          pressedAt: now,
          // Set when the press first travels past the threshold, which is when
          // the gesture becomes a swipe. Timing from the press instead would
          // count a long hold before the drag, and replay the swipe far slower
          // than it was made.
          swipeStartedAt: null,
          // Flipped once the press has travelled past the threshold; from then
          // on the gesture can only end as a swipe or be cancelled.
          swiping: false,
          live: liveTouchRef.current !== false,
          touchDownSent: false,
          touchDownFailed: false,
          endedPoint: null,
          endedAt: null,
          samples: [{ x: start.x, y: start.y, t: now }],
          // The press mark, made on the way down. It is moved to the release
          // point if the gesture turns out to be a tap somewhere else, and kept
          // as the start of the drag line if it becomes a swipe — either way the
          // press is acknowledged without waiting for the outcome.
          markId: null,
        }
        // Acknowledge the press now rather than on release: the device's own
        // reply is a later frame, and waiting to find out whether this is a tap
        // or a swipe would leave the first ~0.4 s of every gesture unacknowledged.
        const point = toStagePoint(stage, event.clientX, event.clientY)
        gestureRef.current.markId = markPoint(point.left, point.top)
        clearLongPressTimer()
        setPressState('pressing')
        const longPressTimer = setTimeout(() => {
          if (longPressTimerRef.current !== longPressTimer) return
          longPressTimerRef.current = null
          if (gestureRef.current?.id === gestureId && !gestureRef.current.swiping) {
            setPressState('longpress')
          }
        }, LONG_PRESS_MS)
        if (typeof longPressTimer?.unref === 'function') longPressTimer.unref()
        longPressTimerRef.current = longPressTimer
        try {
          // Optional-chained: a synthetic event in a test has no such method,
          // and losing capture is a degraded gesture, not a broken panel.
          image.setPointerCapture?.(event.pointerId)
        } catch {
          // A pointer id the browser no longer tracks; the handlers below still
          // work for a pointer that stays over the picture.
        }
      }

      /**
       * Track the press, and turn it into a swipe once it has travelled far
       * enough.
       *
       * The threshold is compared in *display* pixels: `clientX`/`clientY` are
       * exactly what the finger did on screen, while the device conversion
       * divides by the picture's box. Comparing device pixels instead would make
       * the gesture's meaning depend on how far the capture happened to be
       * scaled down.
       */
      function onShotPointerMove(event) {
        const gesture = gestureRef.current
        if (gesture === null) return
        if (gesture.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== gesture.pointerId) return
        const dx = event.clientX - gesture.startClientX
        const dy = event.clientY - gesture.startClientY
        // Remember the furthest the pointer ever got, not just where it is now.
        // A gesture that travels out and comes back to near its start would
        // otherwise be judged on its final position and read as a tap, which is
        // the "I meant to scroll and it clicked instead" failure.
        gesture.maxTravel = Math.max(gesture.maxTravel, Math.hypot(dx, dy))
        if (!gesture.swiping && gesture.maxTravel < gesture.threshold) return
        const now = Date.now()
        // Timing starts when the gesture *becomes* a swipe. Measuring from the
        // press would count a long hold before the drag as part of the swipe, and
        // a deliberate press-then-drag would be replayed far slower than it was
        // made.
        if (!gesture.swiping) gesture.swipeStartedAt = now
        if (!gesture.swiping) {
          clearLongPressTimer()
          setPressState((current) => (current === 'longpress' ? 'pressing' : current))
        }
        gesture.swiping = true
        const current = toDevicePoint(gesture.image, event.clientX, event.clientY)
        // The pointer left the picture entirely: keep the last point the device
        // can actually name rather than sending an out-of-range coordinate.
        if (current === null) return
        gesture.lastPoint = current
        recordGestureSample(gesture.samples, current, now)

        if (gesture.live && !gesture.touchDownFailed) {
          if (!gesture.touchDownSent) {
            gesture.touchDownSent = true
            gesture.lastSentPoint = gesture.start
            const downAt = gesture.swipeStartedAt ?? now
            sendInput(
              { action: 'touchDown', x: gesture.start.x, y: gesture.start.y },
              undefined,
              {
                gestureId: gesture.id,
                onDispatch: () => {
                  gesture.sentPoint = gesture.start
                  gesture.sentAt = downAt
                },
                onSuccess: () => { liveTouchRef.current = true },
                onUnavailable: () => fallbackFromLiveTouch(gesture),
              },
            )
          }
          if (current.x !== gesture.lastSentPoint.x || current.y !== gesture.lastSentPoint.y) {
            gesture.lastSentPoint = current
            const movePoint = current
            const moveAt = now
            sendInput(
              { action: 'touchMove', x: movePoint.x, y: movePoint.y },
              undefined,
              {
                gestureId: gesture.id,
                onDispatch: () => {
                  gesture.sentPoint = movePoint
                  gesture.sentAt = moveAt
                },
                onUnavailable: () => fallbackFromLiveTouch(gesture),
              },
            )
          }
        }

        const from = toStagePoint(gesture.stage, gesture.startClientX, gesture.startClientY)
        // The line stops where the device coordinate stops. Drawing it at the
        // raw pointer position would run past the edge of the picture while the
        // status line already reports the clamped point, so the two would
        // disagree about where the swipe is going to end.
        const to = stagePointOfDevice(gesture.image, current, gesture.stage)
        // Whether the pointer has left the picture, which the device coordinate
        // cannot express on its own: it is clamped to the edge both when the
        // pointer is sitting on the border and when it has gone well past it. The
        // line stops correctly either way; this only lets the status line say the
        // swipe is being cut short.
        const box = gesture.image.getBoundingClientRect()
        const atEdge = event.clientX < box.left || event.clientX > box.right
          || event.clientY < box.top || event.clientY > box.bottom
        queueDrag({ from, to, start: gesture.start, current, atEdge, live: gesture.live })
      }

      /** Release a live gesture using a single batched RPC (or a swipe if touchDown never left). */
      function finishLiveGesture(gesture, end, now) {
        gesture.endedPoint = end
        gesture.endedAt = now
        const queue = queueRef.current
        const queuedDown = queue.items.some(
          (queued) => queued.gestureId === gesture.id && queued.payload.action === 'touchDown',
        )
        queue.items = queue.items.filter((queued) => queued.gestureId !== gesture.id)
        if (queuedDown) {
          gesture.touchDownSent = false
          sendFallbackSwipe(gesture, end, now)
          return
        }
        const from = gesture.sentPoint ?? gesture.start
        const steps = buildLiveReleaseSteps(gesture, from, end, now)
        const noteText = t('shot.swipeDone', { x: gesture.start.x, y: gesture.start.y, toX: end.x, toY: end.y })
        const options = {
          gestureId: gesture.id,
          onUnavailable: () => fallbackFromLiveTouch(gesture),
        }
        if (steps.length === 1) {
          sendInput({ action: 'touchUp', x: end.x, y: end.y }, noteText, options)
          return
        }
        sendInput({ action: 'touchBatch', steps }, noteText, options)
      }

      /**
       * End the gesture: a swipe if it travelled, otherwise a tap.
       *
       * A tap is sent on the way *up*, not on the way down, because only now is
       * it known not to have been a swipe. The cost is that a long press reads as
       * a tap on release, which is what the device does too for a press it did
       * not interpret as a long press.
       */
      function onShotPointerUp(event) {
        const gesture = gestureRef.current
        if (gesture === null) return
        if (gesture.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== gesture.pointerId) return
        gestureRef.current = null
        // The gesture is over: a position queued a moment ago must not paint a
        // line back onto a picture that is no longer being dragged.
        cancelDragFrame()
        clearLongPressTimer()
        setPressState(null)
        setDrag(null)
        try {
          gesture.image.releasePointerCapture?.(event.pointerId)
        } catch {
          // Releasing a capture that was never taken is not an error worth
          // surfacing.
        }

        const now = Date.now()
        const end = toDevicePoint(gesture.image, event.clientX, event.clientY)
        if (end === null) {
          if (gesture.live && gesture.touchDownSent && !gesture.touchDownFailed) {
            finishLiveGesture(gesture, gesture.lastPoint, now)
          }
          return
        }

        if (gesture.swiping && gesture.maxTravel >= gesture.threshold) {
          const { start } = gesture
          if (gesture.live && !gesture.touchDownFailed) {
            finishLiveGesture(gesture, end, now)
            return
          }
          // Fallback mode (daemon unavailable): a swipe that ends where it
          // started becomes a tap, otherwise replay with trailing velocity.
          if (end.x !== start.x || end.y !== start.y) {
            sendFallbackSwipe(gesture, end, now)
            return
          }
        }

        const point = toStagePoint(gesture.stage, event.clientX, event.clientY)
        // The press already made a mark; move it to where the tap landed rather
        // than adding a second one a few pixels away.
        if (gesture.markId === null) markPoint(point.left, point.top)
        else moveMark(gesture.markId, point.left, point.top)

        // A press held still is a long press on a real device — its own gesture,
        // usually a context menu or a drag handle — not a click. Sending a click
        // for it performs an action the user did not make.
        if (now - gesture.pressedAt >= LONG_PRESS_MS) {
          sendInput({ action: 'longClick', x: end.x, y: end.y }, t('shot.longPressDone', { x: end.x, y: end.y }))
          return
        }

        sendInput({ action: 'click', x: end.x, y: end.y }, t('shot.tapDone', { x: end.x, y: end.y }))
      }

      /**
       * The browser took the gesture away — a scroll, a pinch, an OS swipe, or
       * the window losing focus.
       *
       * When a live touchDown has already reached the device, release the
       * finger at its last known position so the screen is never left stuck
       * pressed. Before threshold, nothing was sent so cancelling sends nothing.
       */
      function onShotPointerCancel() {
        const gesture = gestureRef.current
        gestureRef.current = null
        cancelDragFrame()
        clearLongPressTimer()
        setPressState(null)
        setDrag(null)
        if (gesture !== null && gesture.live && gesture.touchDownSent && !gesture.touchDownFailed) {
          const point = gesture.lastPoint
          gesture.endedPoint = point
          gesture.endedAt = Date.now()
          // Drop any queued touchMove for this cancelled gesture and lift immediately.
          queueRef.current.items = queueRef.current.items.filter((queued) => queued.gestureId !== gesture.id)
          sendInput({ action: 'touchUp', x: point.x, y: point.y }, undefined, { gestureId: gesture.id })
        }
        // The press mark was made for a gesture that never completed. Leaving it
        // would claim an input the device never received, so it goes with the
        // gesture it belonged to.
        if (gesture !== null && gesture.markId !== null) {
          marksRef.current = marksRef.current.filter((entry) => entry.id !== gesture.markId)
          setRipples(marksRef.current.slice())
        }
      }

      /** Press one named device key (Back/Home/Power). */
      function pressKey(key, label) {
        sendInput({ action: 'key', key }, t('shot.keyDone', { key: label }))
      }

      // ── UI tree ────────────────────────────────────────────────────────────

      const loadTree = useCallback(async () => {
        if (device === null) return
        treeTicketRef.current += 1
        const ticket = treeTicketRef.current
        setTreeLoading(true)
        setTreeError(null)
        try {
          const body = await requestJson(withQuery('/hdc/uitree', { device, all_nodes: showAllNodes ? 1 : undefined }))
          // A newer read, or a device switch, has superseded this one.
          if (ticket !== treeTicketRef.current) return
          setTree({
            device,
            allNodes: showAllNodes,
            rows: treeRowsOf(body),
            truncated: body?.truncated === true,
            raw: typeof body?.content === 'string' ? body.content : '',
          })
        } catch (error) {
          if (ticket !== treeTicketRef.current) return
          setTreeError(messageOf(error))
        } finally {
          if (ticket === treeTicketRef.current) setTreeLoading(false)
        }
      }, [device, showAllNodes])

      // Load when the section is open and what is cached belongs to another
      // device or another "all nodes" choice. `tree` IS a dependency: the early
      // return below makes the post-load re-run a no-op, so this cannot loop,
      // and listing it keeps the read honest instead of closing over a stale
      // value.
      useEffect(() => {
        if (!treeOpen || device === null) return
        if (tree !== null && tree.device === device && tree.allNodes === showAllNodes) return
        loadTree()
      }, [treeOpen, device, showAllNodes, loadTree, tree])

      // ── logs ───────────────────────────────────────────────────────────────

      const loadLogs = useCallback(async () => {
        if (device === null) return
        logsTicketRef.current += 1
        const ticket = logsTicketRef.current
        setLogsLoading(true)
        setLogsError(null)
        try {
          const body = await requestJson(withQuery('/hdc/logs', { device, crash: crashOnly ? 1 : undefined }))
          if (ticket !== logsTicketRef.current) return
          setLogs({
            device,
            crashOnly,
            content: typeof body?.content === 'string' ? body.content : '',
            matches: Number(body?.matches ?? 0),
            scanned: Number(body?.scanned ?? 0),
          })
        } catch (error) {
          if (ticket !== logsTicketRef.current) return
          setLogsError(messageOf(error))
        } finally {
          if (ticket === logsTicketRef.current) setLogsLoading(false)
        }
      }, [device, crashOnly])

      // Same shape as the tree effect: `logs` is listed so the read is not a
      // stale closure, and the early return prevents a reload loop.
      useEffect(() => {
        if (!logsOpen || device === null) return
        if (logs !== null && logs.device === device && logs.crashOnly === crashOnly) return
        loadLogs()
      }, [logsOpen, device, crashOnly, loadLogs, logs])

      // ── render helpers ─────────────────────────────────────────────────────

      const list = devices ?? NO_DEVICES
      const busy = inputBusy

      function renderHead() {
        return h(
          'header',
          { className: 'hdci-head' },
          h(
            'div',
            { className: 'hdci-heading' },
            h('h1', { className: 'hdci-title' }, t('title')),
            h(
              'span',
              {
                className: 'hdci-sub',
                'data-error': devicesError !== null && devices === null ? 'true' : undefined,
                title: hdcPath ?? undefined,
              },
              hdcPath === null ? t('subtitle') : t('device.detected', { path: hdcPath }),
            ),
          ),
          h(
            'div',
            { className: 'hdci-controls' },
            h('label', { className: 'hdci-sub', htmlFor: 'hdci-device-select', style: { margin: 0 } }, t('device.label')),
            h(
              'select',
              {
                id: 'hdci-device-select',
                className: 'hdci-select',
                value: device ?? '',
                'aria-label': t('device.select'),
                disabled: list.length === 0 || devicesLoading,
                onChange: (event) => setDevice(event.target.value === '' ? null : event.target.value),
              },
              list.length === 0
                ? h('option', { value: '' }, devicesLoading ? t('action.busy') : t('device.none'))
                : list.map((serial) => h('option', { key: serial, value: serial }, serial)),
            ),
            actionButton('refresh-devices', t('device.refresh'), loadDevices, {
              variant: 'flat',
              disabled: devicesLoading,
            }),
          ),
        )
      }

      /**
       * The live picture, or what stands in for it.
       *
       * An MJPEG stream is a plain `<img>`: the browser paints each part as it
       * arrives. `key` is the whole re-open mechanism — an `<img>` keeps its
       * current source until the element is replaced, so a device switch or a
       * retry bumps the nonce, which remounts the element and starts a new
       * stream. `onError` is the only signal a stream gives when it cannot be
       * opened at all: the Host refuses before writing headers, and the browser
       * reports a failed image load.
       */
      function renderStage() {
        if (device === null) {
          return h('div', { className: 'hdci-placeholder' }, t('device.none'))
        }
        if (streamError !== null) {
          return h(
            'div',
            { className: 'hdci-placeholder' },
            h('span', { className: 'hdci-errorbox' }, streamError),
            actionButton('restart-stream', t('error.retry'), restartStream, {}),
          )
        }
        // The <img> goes straight into the stage. No wrapper: `max-height: 100%`
        // resolves against the stage only when the image *is* the stage's child,
        // and a wrapper with `flex: 1` gave the image a taller box to fill, so it
        // grew past the stage and was clipped. That also skewed every tap: the
        // click→device-pixel math divides by the image's own box, so a box
        // 259 px taller than what was drawn sent taps hundreds of pixels off.
        return [
          h('img', {
            // `key` remounts the element, which is what re-opens the stream.
            key: `${device}#${streamNonce}`,
            className: 'hdci-shot',
            src: withQuery('/hdc/stream', { device }),
            alt: t('shot.live'),
            draggable: false,
            onPointerDown: onShotPointerDown,
            // The rest of the gesture, including what happens after it leaves the
            // picture thanks to the pointer capture taken on the way down.
            onPointerMove: onShotPointerMove,
            onPointerUp: onShotPointerUp,
            onPointerCancel: onShotPointerCancel,
            onLoad: (event) => {
              setStreamReady(true)
              const image = event.currentTarget
              if (image.naturalWidth > 0) setFrameSize({ width: image.naturalWidth, height: image.naturalHeight })
            },
            // A stream that fails before its first frame leaves the browser with
            // nothing to paint; this is the only report of that.
            onError: () => {
              setStreamReady(false)
              setStreamError(t('shot.error'))
            },
          }),
          // The swipe being drawn in fallback mode, as an SVG overlay in stage
          // pixels. Hidden during live follow-finger touch so the screen stays
          // uncluttered while the device follows the pointer directly.
          drag === null || drag.live
            ? null
            : h(
                'svg',
                {
                  key: 'drag',
                  className: 'hdci-drag',
                  'aria-hidden': 'true',
                  style: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
                  preserveAspectRatio: 'none',
                },
                h('line', {
                  className: 'hdci-drag-line',
                  x1: drag.from.left,
                  y1: drag.from.top,
                  x2: drag.to.left,
                  y2: drag.to.top,
                }),
                h('circle', { className: 'hdci-drag-dot', cx: drag.from.left, cy: drag.from.top, r: 5 }),
                h('circle', { className: 'hdci-drag-dot', cx: drag.to.left, cy: drag.to.top, r: 5 }),
              ),
          // Tap marks. Absolutely positioned against the stage, so they never
          // take part in its layout and cannot change the picture's box.
          ripples.map((ripple) =>
            h('span', {
              key: ripple.id,
              className: 'hdci-ripple',
              'aria-hidden': 'true',
              style: { left: ripple.left, top: ripple.top },
            })),
          // Until the first frame arrives the <img> has no intrinsic size, so the
          // stage would collapse to its padding. This sits *beside* the image
          // rather than sizing it, so it cannot affect the picture's box.
          streamReady
            ? null
            : h('div', { key: 'overlay', className: 'hdci-overlay' }, t('shot.starting')),
        ]
      }

      /** Status line under the picture: decoded size, last action, errors. */
      function renderStageBar() {
        const parts = []
        if (frameSize !== null) parts.push(t('shot.size', { width: frameSize.width, height: frameSize.height }))
        if (busy) parts.push(t('action.busy'))
        // While a drag is under the finger, the live gesture takes the place of
        // the last result: it is what the user is doing now, and seeing the
        // direction in device pixels is what makes the swipe aimable.
        let status = null
        if (drag !== null) {
          status = h(
            'span',
            { className: 'hdci-bar-note' },
            t('shot.swipeHint', { x: drag.start.x, y: drag.start.y, toX: drag.current.x, toY: drag.current.y }),
            // Past the edge the device coordinate stops advancing, so say why the
            // numbers have stopped instead of looking like a frozen readout.
            drag.atEdge ? h('span', { className: 'hdci-bar-edge' }, ` · ${t('shot.edgeReached')}`) : null,
          )
        } else if (note !== null) {
          status = h('span', { className: 'hdci-bar-note' }, note)
        }
        return h(
          'div',
          { className: 'hdci-bar', 'aria-live': 'polite' },
          h('span', null, parts.join(' · ')),
          status,
          inputError === null ? null : h('span', { className: 'hdci-bar-error' }, inputError),
        )
      }

      function renderActions() {
        // Only the absence of a device disables these. The queue serialises the
        // device work, so a key press during an in-flight tap waits its turn
        // instead of being refused.
        const disabled = device === null
        const elapsed = recordStartedAt === null ? 0 : Math.max(0, Math.round((recordNow - recordStartedAt) / 1000))
        return h(
          'div',
          { className: 'hdci-actions' },
          actionButton('back', t('action.back'), () => pressKey('Back', t('action.back')), { disabled }),
          actionButton('home', t('action.home'), () => pressKey('Home', t('action.home')), { disabled }),
          actionButton('power', t('action.power'), () => pressKey('Power', t('action.power')), { disabled }),
          actionButton('snapshot', t('shot.snapshot'), takeSnapshot, {
            variant: 'primary',
            disabled: device === null || captureBusy || recordBusy,
            title: t('shot.snapshot'),
          }),
          recordBusy
            ? actionButton('stop-record', t('shot.recording', { seconds: elapsed, total: recordSeconds }), stopRecording, {})
            : actionButton('start-record', t('shot.record'), startRecording, {
                disabled: device === null || captureBusy,
                title: t('shot.record'),
              }),
          h(
            'select',
            {
              className: 'hdci-select hdci-select-narrow',
              value: String(recordSeconds),
              'aria-label': t('shot.recordSeconds'),
              disabled: recordBusy,
              onChange: (event) => setRecordSeconds(Number(event.target.value)),
            },
            [5, 10, 20, 30].map((value) =>
              h('option', { key: value, value: String(value) }, t('shot.recordSecondsUnit', { value }))),
          ),
        )
      }

      /** What the last capture or recording produced, with a link to the file. */
      function renderArtifacts() {
        const rows = []
        for (const [key, item] of [['capture', captureNote], ['record', recordNote]]) {
          if (item === null) continue
          rows.push(
            h(
              'div',
              { key, className: 'hdci-artifact' },
              h('span', { className: 'hdci-artifact-text', title: item.text }, item.text),
              item.href === null
                ? null
                : h(
                    'a',
                    { className: 'hdci-link', href: item.href, download: '', target: '_blank', rel: 'noreferrer' },
                    item.label,
                  ),
              typeof item.detail === 'string' && item.detail !== ''
                ? h('span', { className: 'hdci-artifact-detail', title: item.detail }, item.detail)
                : null,
            ),
          )
        }
        if (rows.length === 0) return null
        return h('div', { className: 'hdci-artifacts' }, rows)
      }

      /**
       * Text entry. `uitest uiInput text` writes into whatever field the device
       * has focused, so this row only sends the string: focus is set by tapping
       * the field in the screenshot first.
       */
      function renderTextRow() {
        const disabled = device === null
        const submit = () => {
          const value = textDraft
          if (value === '') return
          sendInput({ action: 'text', text: value }, t('action.textDone'))
          setTextDraft('')
        }
        return h(
          'form',
          {
            className: 'hdci-textrow',
            onSubmit: (event) => {
              event.preventDefault()
              submit()
            },
          },
          h('input', {
            className: 'hdci-textinput',
            type: 'text',
            value: textDraft,
            placeholder: t('action.textPlaceholder'),
            'aria-label': t('action.textPlaceholder'),
            disabled,
            onChange: (event) => setTextDraft(event.target.value),
          }),
          h(
            'button',
            {
              type: 'submit',
              className: 'hdci-btn',
              disabled: disabled || textDraft === '',
              title: t('action.send'),
            },
            t('action.send'),
          ),
        )
      }

      /**
       * One card: collapsible header plus a body that only exists while open.
       *
       * `body` is a *function*, not an element, and that is the point: the panel
       * re-renders on every `pointermove` while a gesture is drawn, and building
       * the tree and log bodies eagerly meant each of those renders walked the
       * whole hierarchy and the whole log list even while both cards were folded
       * and nothing they show had changed. Calling it only when the card is open
       * keeps a drag costing the drag overlay and nothing else.
       */
      function renderCard(key, options) {
        const { title, open, onToggle, count, controls, body } = options
        return h(
          'section',
          { key, className: 'hdci-card', 'data-open': open ? 'true' : 'false' },
          h(
            'div',
            { className: 'hdci-card-head' },
            h(
              'button',
              {
                type: 'button',
                className: 'hdci-card-toggle',
                'aria-expanded': open ? 'true' : 'false',
                onClick: onToggle,
              },
              h('span', { className: 'hdci-caret', 'aria-hidden': 'true' }, '▶'),
              title,
              count === undefined || count === '' ? null : h('span', { className: 'hdci-card-count' }, count),
            ),
            controls,
          ),
          open ? body() : null,
        )
      }

      /**
       * The rows a collapsed tree still shows.
       *
       * Rows arrive in document order with only their depth, so a collapse hides
       * everything after it that is deeper, and nothing more: the first row at
       * the same depth or shallower closes the hidden range. Keeping the
       * original index with each row matters — the collapse set is keyed by it,
       * and a row re-indexed after a parent was folded would stop matching its
       * own state.
       *
       * @param rows - the outline, in document order.
       * @param collapsed - indexes of the folded rows.
       * @returns the visible rows, each with the index it came from.
       */
      function visibleTreeRows(rows, collapsed) {
        const visible = []
        // Depth of the folded row whose descendants are being skipped, or -1
        // when nothing is folded.
        let hidingDeeperThan = -1
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]
          if (hidingDeeperThan >= 0) {
            if (row.depth > hidingDeeperThan) continue
            hidingDeeperThan = -1
          }
          visible.push({ row, index })
          if (row.hasChildren && collapsed.has(index)) hidingDeeperThan = row.depth
        }
        return visible
      }

      /**
       * Whether a stored result still describes what is on screen.
       *
       * Every read is already ticket-guarded, so this cannot normally fail. It
       * is the cheap second check that keeps a stale row from becoming a tap on
       * the wrong device if a future path writes state without a ticket: a
       * button whose coordinates belong to another device must render as a
       * plain line, never as something that can be pressed.
       */
      function treeBelongsToDevice(candidate) {
        return candidate !== null && candidate.device === device && candidate.allNodes === showAllNodes
      }

      function logsBelongToDevice(candidate) {
        return candidate !== null && candidate.device === device && candidate.crashOnly === crashOnly
      }

      function renderTreeBody() {
        if (treeError !== null) return h('div', { className: 'hdci-error-inline' }, treeError)
        if (treeLoading && tree === null) return h('div', { className: 'hdci-note-inline' }, t('tree.loading'))
        if (tree === null) return h('div', { className: 'hdci-note-inline' }, t('tree.empty'))
        // A dump for another device, or with the other node filter, is not what
        // the current picture shows: present it as still loading rather than as
        // something tappable.
        if (!treeBelongsToDevice(tree)) return h('div', { className: 'hdci-note-inline' }, t('tree.loading'))
        // The placeholder is read only when there is no outline to draw: a Host
        // that sent rows has something to show whatever its text says.
        if (tree.rows.length === 0 && isPlaceholder(tree.raw)) return h('div', { className: 'hdci-note-inline' }, t('tree.noMatch'))
        const shown = visibleTreeRows(tree.rows, collapsedRows)
        return h(
          'div',
          { className: 'hdci-tree' },
          // The interaction is not obvious from the rows alone, and a dump can
          // be long: put the hint at the top where it is always in view.
          h('div', { key: 'hint', className: 'hdci-note-inline' }, t('tree.hint')),
          // `role="tree"` sits on the rows alone: the hint and the truncation
          // note are captions, and a tree that contains them would announce two
          // items that cannot be selected.
          h(
            'div',
            { key: 'rows', role: 'tree' },
            shown.map(({ row, index }) => renderTreeRow(row, index)),
          ),
          // A truncated dump silently hides lower controls; say so where the
          // list ends, and point at the switch that widens it.
          tree.truncated ? h('div', { key: 'truncated', className: 'hdci-note-inline' }, t('tree.truncated')) : null,
        )
      }

      /**
       * One outline row: a fold caret, the label, and the row's own tap area.
       *
       * The caret is a separate button from the row on purpose. A row *is* a tap
       * aimed at the device, so folding it there would mean a press meant to
       * open a branch landed as a tap on the phone — the two must not share a
       * target.
       */
      function renderTreeRow(row, index) {
        const folded = collapsedRows.has(index)
        const indentPx = Math.min(TREE_INDENT_MAX_PX, 6 + row.depth * TREE_INDENT_PX)
        const indent = { paddingLeft: `${indentPx}px` }
        const caret = row.hasChildren
          ? h(
              'button',
              {
                key: 'caret',
                type: 'button',
                className: 'hdci-treecaret',
                'aria-expanded': folded ? 'false' : 'true',
                'aria-label': folded ? t('tree.expand') : t('tree.collapse'),
                title: folded ? t('tree.expand') : t('tree.collapse'),
                onClick: () => setCollapsedRows((current) => {
                  const next = new Set(current)
                  if (next.has(index)) next.delete(index)
                  else next.add(index)
                  return next
                }),
              },
              folded ? '▶' : '▼',
            )
          : h('span', { key: 'caret', className: 'hdci-treecaret', 'aria-hidden': 'true' }, '')

        const label = h(
          'span',
          { className: 'hdci-treetext' },
          row.text,
          row.clickable ? h('span', { className: 'hdci-treedot', 'aria-hidden': 'true' }, '·') : null,
        )

        // A row with no tap point stays plain text: a button that cannot do
        // anything is worse than a line that never claimed to.
        const body = row.tap === null
          ? h('span', { className: 'hdci-treerow-body' }, label)
          : h(
              'button',
              {
                key: 'tap',
                type: 'button',
                className: 'hdci-treerow-body',
                title: t('tree.tap', { x: row.tap.x, y: row.tap.y }),
                disabled: device === null,
                onClick: () => sendInput({ action: 'click', x: row.tap.x, y: row.tap.y }, t('tree.tap', { x: row.tap.x, y: row.tap.y })),
              },
              label,
            )

        return h(
          'div',
          {
            key: index,
            className: 'hdci-treerow',
            role: 'treeitem',
            'aria-level': row.depth + 1,
            'aria-expanded': row.hasChildren ? (folded ? 'false' : 'true') : undefined,
            style: indent,
          },
          caret,
          body,
        )
      }

      function renderLogsBody() {
        if (logsError !== null) return h('div', { className: 'hdci-error-inline' }, logsError)
        if (logsLoading && logs === null) return h('div', { className: 'hdci-note-inline' }, t('logs.loading'))
        if (logs === null) return h('div', { className: 'hdci-note-inline' }, t('logs.empty'))
        // Logs from another device must not be shown as this one's: the lines
        // are attributed to whatever is attached now, which would be a lie.
        if (!logsBelongToDevice(logs)) return h('div', { className: 'hdci-note-inline' }, t('logs.loading'))
        if (isPlaceholder(logs.content)) return h('pre', { className: 'hdci-logs', 'data-empty': 'true' }, t('logs.noMatch'))
        return h('pre', { className: 'hdci-logs' }, logs.content)
      }

      function renderSide() {
        return h(
          'div',
          { className: 'hdci-side' },
          renderCard('tree', {
            title: t('tree.title'),
            open: treeOpen,
            onToggle: () => setTreeOpen((open) => !open),
            count: tree !== null && tree.device === device ? `${tree.rows.length}` : '',
            controls: [
              h(
                'label',
                { key: 'all', className: 'hdci-check', title: t('tree.all') },
                h('input', {
                  type: 'checkbox',
                  checked: showAllNodes,
                  onChange: (event) => setShowAllNodes(event.target.checked),
                }),
                t('tree.all'),
              ),
              actionButton('tree-refresh', '↻', () => loadTree(), {
                variant: 'flat',
                disabled: device === null || treeLoading,
                title: t('tree.refresh'),
              }),
            ],
            body: () => h('div', { className: 'hdci-card-body' }, renderTreeBody()),
          }),
          renderCard('logs', {
            title: t('logs.title'),
            open: logsOpen,
            onToggle: () => setLogsOpen((open) => !open),
            count: logs !== null && logs.device === device ? t('logs.summary', { matches: logs.matches, scanned: logs.scanned }) : '',
            controls: [
              h(
                'label',
                { key: 'crash', className: 'hdci-check' },
                h('input', {
                  type: 'checkbox',
                  checked: crashOnly,
                  onChange: (event) => setCrashOnly(event.target.checked),
                }),
                t('logs.crash'),
              ),
              actionButton('logs-refresh', '↻', () => loadLogs(), {
                variant: 'flat',
                disabled: device === null || logsLoading,
                title: t('logs.refresh'),
              }),
            ],
            body: () => h('div', { className: 'hdci-card-body' }, renderLogsBody()),
          }),
        )
      }

      function renderBody() {
        return h(
          'div',
          { className: 'hdci-body' },
          h(
            'div',
            { className: 'hdci-main' },
            h('div', {
              className: 'hdci-stage',
              'data-pressing': pressState === 'pressing' || pressState === 'longpress' ? 'true' : undefined,
              'data-longpress': pressState === 'longpress' ? 'true' : undefined,
              'data-dragging': drag === null ? undefined : 'true',
            }, renderStage()),
            renderStageBar(),
            h(
              'div',
              // The gesture hint used to sit at the very bottom of the column,
              // after the actions, the artifact links and the text row — below the
              // fold in a short window, which is where a user wondering "can I
              // scroll this?" would never see it. It belongs against the picture
              // it describes.
              { className: 'hdci-hint' },
              h('span', { className: 'hdci-hint-grip', 'aria-hidden': 'true' }, '⠿'),
              t('shot.tapHint'),
            ),
            renderActions(),
            renderArtifacts(),
            renderTextRow(),
          ),
          renderSide(),
        )
      }

      /** Nothing attached: say what to do instead of showing empty controls. */
      function renderEmpty() {
        // Only a confirmed missing client earns the install instructions. A
        // failed device list with `hdcPath` absent is usually just "no device
        // attached", and telling that user to install hdc sends them to fix
        // something that works.
        const maybeNoHdc = devicesErrorCode === 'HDC_NOT_FOUND'
        return h(
          'div',
          { className: 'hdci-empty' },
          h(EmptyArtwork),
          h('h2', { className: 'hdci-empty-title' }, t('empty.title')),
          h('p', { className: 'hdci-empty-lead' }, t('empty.lead')),
          h(
            'ul',
            { className: 'hdci-empty-steps' },
            h('li', null, t('empty.step1')),
            h('li', null, t('empty.step2')),
            h('li', null, t('empty.step3')),
          ),
          maybeNoHdc
            ? h(
                'p',
                { className: 'hdci-empty-lead' },
                h('strong', null, t('empty.noHdcTitle')),
                ' — ',
                t('empty.noHdcLead'),
              )
            : null,
          devicesError === null
            ? null
            : h('p', { className: 'hdci-errorbox' }, `${t('error.devices')} — ${devicesError}`),
          actionButton('retry', devicesError === null ? t('empty.retry') : t('error.retry'), loadDevices, {
            variant: 'primary',
            disabled: devicesLoading,
          }),
        )
      }

      function renderMain() {
        if (devices === null) {
          if (devicesError !== null) {
            return h(
              'div',
              { className: 'hdci-empty' },
              h('p', { className: 'hdci-empty-title' }, t('error.devices')),
              h('p', { className: 'hdci-errorbox' }, devicesError),
              actionButton('retry', t('error.retry'), loadDevices, { variant: 'primary', disabled: devicesLoading }),
            )
          }
          return h('div', { className: 'hdci-empty' }, h('p', { className: 'hdci-empty-lead' }, t('action.busy')))
        }
        if (list.length === 0) return renderEmpty()
        return renderBody()
      }

      return h(
        'div',
        { className: 'hdci-page' },
        h('style', { key: 'hdci-style' }, STYLE_TEXT),
        renderHead(),
        renderMain(),
      )
    }

    // ── plugin body ──────────────────────────────────────────────────────────

    const inject = ['slots', 'locale']

    function apply(ctx) {
      // Dictionaries first: the panellist label thunk resolves through this
      // namespace, and the sidebar re-reads labels when the registry revision
      // moves.
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hdc panel: dictionaries')

      const t = ctx.locale.bind(NS)

      // Sidebar entry. The panel is opened by the sidebar itself, which calls
      // `layout.selectPanel(id)` with this id.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            locale: NS,
            // A thunk: the sidebar resolves it per render, so a language switch
            // updates the row without re-registering the entry.
            label: () => t('panel'),
          },
          HdcPanelIcon,
        ),
      )

      // The page. `main` is a keyed slot: the key is what the layout matches
      // against `layoutInfo.activePanelId`, so it must equal the panellist id.
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, HdcPanelPage),
      )
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
