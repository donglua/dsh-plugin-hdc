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

    /**
     * How long a tap mark stays on screen.
     *
     * It has to outlast the CSS animation (420 ms) or the mark would vanish
     * mid-fade, and it is also the window the sweep timer prunes to, so the two
     * are stated together here rather than as a bare number in two places.
     */
    const MARK_LIFETIME_MS = 450

    // ── dictionaries ─────────────────────────────────────────────────────────
    // Inlined rather than fetched: a hand-written bundle has no asset pipeline,
    // and `ctx.locale.register` is the only channel the slot renderer reads for
    // the framework-injected `t` seat.

    const zh = {
      panel: '鸿蒙设备',
      title: '鸿蒙设备',
      subtitle: '通过 hdc 实时看屏、点按、读取 UI 树与日志',
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
      'shot.tapHint': '点画面即在设备同一位置点按',
      'shot.tapDone': '已点击 ({x}, {y})',
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
      'tree.hint': '点一行 = 点击该控件中心点',
      'tree.all': '全部节点',
      'tree.refresh': '刷新 UI 树',
      'tree.loading': '正在读取 UI 树…',
      'tree.empty': '还没有读取 UI 树',
      'tree.noMatch': '没有匹配的节点',
      'tree.truncated': '内容过长，已截断',
      'tree.tap': '点击 ({x}, {y})',
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
      'empty.step2': 'USB 连接，或执行 hdc tconn <ip>:<port> 连接无线设备',
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
      subtitle: 'Live screen, taps, UI hierarchy and logs over hdc',
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
      'shot.tapHint': 'Tap the picture to tap the same spot on the device',
      'shot.tapDone': 'Tapped ({x}, {y})',
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
      'tree.hint': 'Click a row to tap that control',
      'tree.all': 'All nodes',
      'tree.refresh': 'Refresh UI tree',
      'tree.loading': 'Reading the UI tree…',
      'tree.empty': 'The UI tree has not been read yet',
      'tree.noMatch': 'No matching nodes',
      'tree.truncated': 'Content was too long and is truncated',
      'tree.tap': 'Tap ({x}, {y})',
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
      'empty.step2': 'Connect by USB, or run hdc tconn <ip>:<port>',
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
     * Split the Host's one-line-per-node UI tree into clickable rows.
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
          text: line,
          tap: match === null ? null : { x: Number(match[1]), y: Number(match[2]) },
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
   The cursor is drawn rather than the platform's crosshair: a center dot marks
   the exact point that becomes the device coordinate, and the dark core sits on
   a white halo so it stays visible over a light app as well as a dark one — the
   system crosshair disappears into one of the two. The plain keyword stays as
   the fallback for a browser that refuses the SVG. touch-action:none keeps a
   press from turning into a page scroll or a pinch, which would swallow the tap. */
.hdci-shot{display:block;width:auto;height:auto;max-width:100%;max-height:100%;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cg fill='none' stroke-linecap='round'%3E%3Cpath d='M12 3v6M12 15v6M3 12h6M15 12h6' stroke='%23fff' stroke-width='3.4'/%3E%3Cpath d='M12 3v6M12 15v6M3 12h6M15 12h6' stroke='%23111' stroke-width='1.3'/%3E%3C/g%3E%3Ccircle cx='12' cy='12' r='1.3' fill='%23111'/%3E%3C/svg%3E") 12 12, crosshair;touch-action:none;-webkit-user-select:none;user-select:none}
.hdci-ripple{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;pointer-events:none;border:2px solid var(--dsw-alias-state-business-primary,#2f6fed);background:rgba(47,111,237,.22);box-shadow:0 0 0 1px rgba(255,255,255,.35) inset;animation:hdci-ripple 420ms var(--ds-ease-out,ease-out) forwards}
@keyframes hdci-ripple{0%{transform:scale(.55);opacity:.95}100%{transform:scale(1.6);opacity:0}}
@media (prefers-reduced-motion:reduce){.hdci-ripple{animation:none;opacity:.85}}
.hdci-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}
.hdci-placeholder{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.hdci-placeholder-title{font-size:13px;color:var(--dsw-alias-label-secondary)}
.hdci-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
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
.hdci-treerow{display:block;width:100%;padding:3px 6px;font-family:var(--ds-font-family-code);font-size:11.5px;line-height:1.55;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary)}
button.hdci-treerow{color:var(--dsw-alias-label-primary);cursor:pointer}
button.hdci-treerow:hover{background:var(--dsw-alias-interactive-bg-hover)}
button.hdci-treerow:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
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
      const { variant = 'default', disabled = false, title } = options ?? {}
      return h(
        'button',
        {
          key,
          type: 'button',
          className: variant === 'flat' ? 'hdci-btn hdci-btn-flat' : variant === 'primary' ? 'hdci-btn hdci-btn-primary' : 'hdci-btn',
          onClick,
          disabled,
          title: title ?? label,
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

      const [streamNonce, setStreamNonce] = useState(0)
      const [streamError, setStreamError] = useState(null)
      const [streamReady, setStreamReady] = useState(false)
      const [frameSize, setFrameSize] = useState(null)

      const restartStream = useCallback(() => {
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
          setRecordNote({
            text: body?.kind === 'frames' ? t('shot.recordFrames', { name }) : t('shot.recordDone', { name }),
            href: typeof body?.artifactId === 'string' ? `/hdc/artifact/${body.artifactId}` : null,
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
        if (markSweepRef.current !== null) {
          clearTimeout(markSweepRef.current)
          markSweepRef.current = null
        }
      }, [device])

      // Unmount: no timer or in-flight request survives this.
      useEffect(() => () => {
        const controller = recordAbortRef.current
        if (controller !== null) controller.abort()
        // The sweep timer holds a state setter; firing it after unmount would
        // warn and keep the closure alive.
        if (markSweepRef.current !== null) {
          clearTimeout(markSweepRef.current)
          markSweepRef.current = null
        }
      }, [])

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
       * The queue is per device. A switch clears it, because a tap meant for the
       * old device must not land on the new one.
       */
      const queueRef = useRef({ device: null, items: [], running: false })

      const drainQueue = useCallback(async () => {
        const queue = queueRef.current
        if (queue.running) return
        queue.running = true
        try {
          while (queue.items.length > 0) {
            const item = queue.items.shift()
            try {
              await requestJson('/hdc/input', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ device: queue.device, ...item.payload }),
              })
              setNote(item.done)
              setInputError(null)
            } catch (error) {
              setNote(null)
              setInputError(messageOf(error))
            }
          }
        } finally {
          queue.running = false
          setInputBusy(false)
        }
      }, [])

      const sendInput = useCallback(
        (payload, done) => {
          if (device === null) return
          const queue = queueRef.current
          if (queue.device !== device) {
            queue.device = device
            queue.items = []
          }
          queue.items.push({ payload, done })
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
       * Map a press on the <img> to device pixels, and acknowledge it at once.
       *
       * `pointerdown` rather than `click`: a click waits for the button to come
       * back up, so a press that drifts a few pixels — the normal shape of a
       * fingertip — is cancelled by the browser as a drag and never lands. A tap
       * here is an intent sent to a remote device, not a local button, so it is
       * taken on the way down. Touch and pen presses never raise a `click` at all
       * on some setups, and they arrive on this same event.
       *
       * The mapping is `(pointer - box.left) / box.width * naturalWidth`, then
       * floored, *not rounded*. `naturalWidth` is the capture's own pixel count
       * and the Host captures at device resolution, so the ratio is the exact
       * display→device scale to undo. Flooring turns the scaled position into the
       * index of the pixel it landed in; rounding instead credits the tap to
       * whichever pixel center is nearer, which biases every coordinate by up to
       * half a pixel and can reach a pixel past the edge at the far side. The
       * clamp then keeps a press on the very border inside the screen.
       *
       * Per axis on purpose: it stays correct even if a layout ever stretches the
       * two axes differently, and it costs one division each.
       */
      function onShotPointerDown(event) {
        // A tap is an intent, not a state to sample. Dropping one because the
        // previous request is still in flight is what makes a double tap or a
        // fast second tap vanish, so they queue instead (see `sendInput`).
        if (device === null) return
        // The second and later taps of a double click. Without this a pen's
        // eraser button or a middle-click also counts as a tap.
        if (typeof event.button === 'number' && event.button !== 0) return
        const image = event.currentTarget
        const width = image.naturalWidth
        const height = image.naturalHeight
        // No frame has decoded yet: there is nothing to map against, and the
        // overlay covers this case anyway.
        if (width === 0 || height === 0) return
        const box = image.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return
        const x = clamp(Math.floor(((event.clientX - box.left) / box.width) * width), 0, width - 1)
        const y = clamp(Math.floor(((event.clientY - box.top) / box.height) * height), 0, height - 1)

        // Acknowledge the press now. The device's own reply arrives on a later
        // frame, which can be 400 ms away, and a tap with no feedback until then
        // reads as a missed tap.
        //
        // The mark is positioned in *stage* pixels, not percentages. The stage is
        // the containing block for an absolutely positioned child, and the picture
        // is usually narrower than the stage (a tall phone screen in a wide
        // panel), so a percentage of the picture landed the mark well outside the
        // picture whenever the two differed.
        //
        // An absolutely positioned child is laid out against the *padding* box of
        // its containing block, so the border has to come off the stage origin.
        // `clientLeft`/`clientTop` are the border widths the browser already laid
        // out; reading them costs nothing, while `getComputedStyle` forces a style
        // recalc on every tap — during a ~5 fps stream repaint that is the one
        // avoidable cost in this path.
        const stage = image.parentElement
        if (stage !== null) {
          const stageBox = stage.getBoundingClientRect()
          rippleIdRef.current += 1
          const id = rippleIdRef.current
          const mark = {
            id,
            at: Date.now(),
            left: `${event.clientX - stageBox.left - stage.clientLeft}px`,
            top: `${event.clientY - stageBox.top - stage.clientTop}px`,
          }
          marksRef.current.push(mark)
          setRipples(marksRef.current.slice())
          // One timer for the whole list, armed only when none is pending: a
          // burst of taps would otherwise schedule one timer each, and every one
          // of them would rebuild the array.
          if (markSweepRef.current === null) {
            markSweepRef.current = setTimeout(sweepMarks, MARK_LIFETIME_MS)
          }
        }
        sendInput({ action: 'click', x, y }, t('shot.tapDone', { x, y }))
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
            rows: parseTreeRows(body?.content),
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
        return h(
          'div',
          { className: 'hdci-bar', 'aria-live': 'polite' },
          h('span', null, parts.join(' · ')),
          note === null ? null : h('span', { className: 'hdci-bar-note' }, note),
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

      /** One card: collapsible header plus a body that only exists while open. */
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
          open ? body : null,
        )
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
        if (isPlaceholder(tree.raw)) return h('div', { className: 'hdci-note-inline' }, t('tree.noMatch'))
        return h(
          'div',
          { className: 'hdci-tree' },
          // The interaction is not obvious from the rows alone, and a dump can
          // be long: put the hint at the top where it is always in view.
          h('div', { key: 'hint', className: 'hdci-note-inline' }, t('tree.hint')),
          tree.rows.map((row, index) =>
            row.tap === null
              ? h('div', { key: index, className: 'hdci-treerow' }, row.text)
              : h(
                  'button',
                  {
                    key: index,
                    type: 'button',
                    className: 'hdci-treerow',
                    title: t('tree.tap', { x: row.tap.x, y: row.tap.y }),
                    disabled: device === null,
                    onClick: () => sendInput({ action: 'click', x: row.tap.x, y: row.tap.y }, t('tree.tap', { x: row.tap.x, y: row.tap.y })),
                  },
                  row.text,
                ),
          ),
          // A truncated dump silently hides lower controls; say so where the
          // list ends, and point at the switch that widens it.
          tree.truncated ? h('div', { key: 'truncated', className: 'hdci-note-inline' }, t('tree.truncated')) : null,
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
            body: h('div', { className: 'hdci-card-body' }, renderTreeBody()),
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
            body: h('div', { className: 'hdci-card-body' }, renderLogsBody()),
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
            h('div', { className: 'hdci-stage' }, renderStage()),
            renderStageBar(),
            renderActions(),
            renderArtifacts(),
            renderTextRow(),
            h('div', { className: 'hdci-bar' }, t('shot.tapHint')),
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
