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

    /**
     * Auto-refresh cadence. A device screenshot is a shell round-trip, so 1.5s
     * keeps taps feeling live without hammering `hdc` while nobody is looking.
     * Only one capture is in flight per device at a time (see `loadShot`), so a
     * slow capture delays the next tick instead of stacking requests.
     */
    const POLL_INTERVAL_MS = 1500

    /** Stable empty list, so the "no devices" branch never allocates. */
    const NO_DEVICES = Object.freeze([])

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
      'auto.label': '自动刷新',
      'action.refreshShot': '刷新截图',
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
      'shot.updated': '更新于 {time}',
      'shot.loading': '正在截图…',
      'shot.empty': '还没有截图',
      'shot.stale': '本次截图失败，画面停在上一帧',
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
      'empty.noHdcLead': 'Host 上没找到 hdc。在插件配置的 hdcPath 里填它的绝对路径，DevEco Studio 自带一个。',
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
      'auto.label': 'Auto refresh',
      'action.refreshShot': 'Refresh screenshot',
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
      'shot.updated': 'Updated {time}',
      'shot.loading': 'Capturing…',
      'shot.empty': 'No screenshot yet',
      'shot.stale': 'The last capture failed; the picture shows an older frame',
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
      'empty.noHdcLead': 'The Host could not find hdc. Set hdcPath to its absolute path in the plugin config; DevEco Studio ships one.',
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

    /** Best-effort failure text: the Host's message, else the HTTP status. */
    async function failureText(response) {
      let body
      try {
        body = await response.json()
      } catch {
        // A dropped connection or a non-JSON body leaves only the status line.
        body = undefined
      }
      return describeError(body) ?? `request failed (HTTP ${response.status})`
    }

    /** Turn anything thrown into a string a user can read. */
    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message
      return String(error)
    }

    /** Decode one JSON response, throwing on transport and Host-side failures. */
    async function requestJson(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        throw new Error(`cannot reach the DSH server: ${messageOf(error)}`)
      }
      if (!response.ok) throw new Error(await failureText(response))
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error('the host returned a non-JSON body')
      }
      const declared = describeError(body)
      if (declared !== undefined) throw new Error(declared)
      return body
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
     * Decide whether a response body starts with a known image signature.
     *
     * Mirrors the Host's own sniffing so the two agree on what "a screenshot"
     * is, and lets the panel tell a real frame from a JSON failure body without
     * depending on a `content-type` header the Host may not set.
     *
     * @param bytes - the first few bytes of the response.
     */
    function isImageBytes(bytes) {
      const at = (offset, expected) => expected.every((byte, index) => bytes[offset + index] === byte)
      if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true
      if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return true
      if (bytes.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return true
      return bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])
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

    /** Wall-clock time for the "updated at" caption. */
    function clockOf(at) {
      if (typeof at !== 'number') return ''
      return new Date(at).toLocaleTimeString()
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
.hdci-select:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.hdci-switch{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 11px;font:inherit;font-size:12.5px;line-height:1;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-card-fill);color:var(--dsw-alias-label-secondary);cursor:pointer}
.hdci-switch[aria-checked='true']{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}
.hdci-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.hdci-switch-track{position:relative;width:26px;height:15px;flex:none;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.hdci-switch-track::after{content:'';position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}
.hdci-switch[aria-checked='true'] .hdci-switch-track{background:var(--dsw-alias-state-business-primary)}
.hdci-switch[aria-checked='true'] .hdci-switch-track::after{transform:translateX(11px)}
.hdci-body{flex:1;min-height:0;display:flex;gap:14px;padding:0 20px 20px}
.hdci-main{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;flex:1 1 56%}
.hdci-side{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;flex:1 1 44%}
.hdci-stage{position:relative;flex:1;min-height:160px;display:flex;align-items:center;justify-content:center;padding:10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
/* No border on the image itself: getBoundingClientRect() includes borders, and
   the click→device-pixel math divides by that box, so a border would bias every
   tap by its width. The stage around it carries the visual edge instead. */
.hdci-shot{display:block;width:auto;height:auto;max-width:100%;max-height:100%;border-radius:var(--dsw-radius-sm);cursor:crosshair}
.hdci-placeholder{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.hdci-placeholder-title{font-size:13px;color:var(--dsw-alias-label-secondary)}
.hdci-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.hdci-bar-note{color:var(--dsw-alias-state-success-primary)}
.hdci-bar-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
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

    /** A labelled on/off control; a button with `role="switch"` keeps the host look. */
    function toggleSwitch(label, checked, onToggle) {
      return h(
        'button',
        {
          type: 'button',
          className: 'hdci-switch',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          onClick: () => onToggle(!checked),
        },
        h('span', { className: 'hdci-switch-track', 'aria-hidden': 'true' }),
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
      const [devicesLoading, setDevicesLoading] = useState(true)
      const [hdcPath, setHdcPath] = useState(null)
      const [device, setDevice] = useState(null)

      const [shot, setShot] = useState(null)
      const [shotSize, setShotSize] = useState(null)
      const [shotLoading, setShotLoading] = useState(false)
      const [shotError, setShotError] = useState(null)
      const [autoRefresh, setAutoRefresh] = useState(true)

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

      // Object URL and in-flight capture live in refs: they are resources, not
      // render state, and must be released exactly once. The in-flight record
      // carries its device so a device switch is never blocked by the previous
      // device's capture still unwinding.
      const shotUrlRef = useRef(null)
      const shotInflightRef = useRef(null)
      const shotSequenceRef = useRef(0)

      /** Drop the current object URL. The only place that revokes it. */
      const releaseShotUrl = useCallback(() => {
        const previous = shotUrlRef.current
        shotUrlRef.current = null
        if (previous !== null) URL.revokeObjectURL(previous)
      }, [])

      /** Abort the capture in flight, if any. */
      const abortShot = useCallback(() => {
        const inflight = shotInflightRef.current
        shotInflightRef.current = null
        if (inflight !== null) inflight.controller.abort()
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
          // Keep the current pick when it is still attached; otherwise fall to
          // the first device so the panel is usable immediately after plugging in.
          setDevice((current) => (current !== null && list.includes(current) ? current : list[0] ?? null))
        } catch (error) {
          setDevicesError(messageOf(error))
          setDevices((current) => current ?? NO_DEVICES)
        } finally {
          setDevicesLoading(false)
        }
      }, [])

      useEffect(() => {
        loadDevices()
      }, [loadDevices])

      // ── screenshot ─────────────────────────────────────────────────────────

      /**
       * Fetch one frame.
       * @param quiet - true for polling: no spinner, no flicker on the picture;
       *   the current image stays up until the replacement is decoded.
       */
      const loadShot = useCallback(
        async (quiet) => {
          if (device === null) return
          // A poll and a manual refresh can overlap. Only one capture per device
          // at a time is worth running: the second would return the same screen.
          const inflight = shotInflightRef.current
          if (inflight !== null && inflight.device === device) return
          if (inflight !== null) inflight.controller.abort()
          const controller = new AbortController()
          shotInflightRef.current = { device, controller }
          shotSequenceRef.current += 1
          const sequence = shotSequenceRef.current
          if (!quiet) {
            setShotLoading(true)
            setShotError(null)
          }
          try {
            let response
            try {
              response = await fetch(withQuery('/hdc/screenshot', { device }), {
                signal: controller.signal,
                headers: { accept: 'image/png' },
              })
            } catch (error) {
              if (controller.signal.aborted) return
              throw new Error(`cannot reach the DSH server: ${messageOf(error)}`)
            }
            if (!response.ok) throw new Error(await failureText(response))
            // A Host that answers 200 with its JSON failure envelope would
            // otherwise become an object URL for a text blob, i.e. a broken
            // <img> with no explanation. Decide on the bytes, not the header:
            // the Host may omit `content-type`, and a rejected real PNG would
            // be worse than the case this guards.
            const blob = await response.blob()
            // 12 bytes: enough for every signature the sniffer accepts, and WebP
            // needs the far marker at offset 8 to be conclusive.
            const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
            if (!isImageBytes(bytes)) {
              // The body is a failure envelope, so its message is the useful part.
              throw new Error(await failureText(response))
            }
            if (shotSequenceRef.current !== sequence) return
            const url = URL.createObjectURL(blob)
            const previous = shotUrlRef.current
            shotUrlRef.current = url
            // Revoke the frame this one replaces: every poll mints a new URL,
            // and without this the tab holds one blob per tick forever.
            if (previous !== null) URL.revokeObjectURL(previous)
            setShot({ url, at: Date.now() })
            setShotError(null)
          } catch (error) {
            if (controller.signal.aborted) return
            // A failed poll must still be visible: a silent stale frame reads
            // as "the device is frozen" instead of "the capture failed".
            setShotError(messageOf(error))
          } finally {
            if (shotInflightRef.current !== null && shotInflightRef.current.controller === controller) {
              shotInflightRef.current = null
            }
            if (!quiet) setShotLoading(false)
          }
        },
        [device],
      )

      // Switching devices invalidates everything that came from the old one.
      useEffect(() => {
        setTree(null)
        setTreeError(null)
        setLogs(null)
        setLogsError(null)
        setNote(null)
        setInputError(null)
        setShotSize(null)
        // Whatever was still arriving belongs to the previous device.
        abortShot()
        if (device === null) {
          releaseShotUrl()
          setShot(null)
          setShotError(null)
          return undefined
        }
        // A frame of another device must not linger under the new selection.
        releaseShotUrl()
        setShot(null)
        loadShot(false)
        return abortShot
      }, [device, loadShot, releaseShotUrl, abortShot])

      // Auto-refresh. The interval is recreated only when the device or the
      // switch changes, and removed on unmount.
      useEffect(() => {
        if (!autoRefresh || device === null) return undefined
        const timer = setInterval(() => {
          // A hidden tab still costs a device capture; nobody is reading it.
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          loadShot(true)
        }, POLL_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [autoRefresh, device, loadShot])

      // Coming back to the tab should show the current screen at once, not the
      // frame from before the user switched away.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onVisibility = () => {
          if (document.visibilityState === 'visible' && autoRefresh) loadShot(true)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [autoRefresh, loadShot])

      // Unmount: no timer, listener, controller or object URL survives this.
      useEffect(
        () => () => {
          abortShot()
          releaseShotUrl()
        },
        [abortShot, releaseShotUrl],
      )

      // ── input ──────────────────────────────────────────────────────────────

      /** Send one device input and refresh the picture afterwards. */
      const sendInput = useCallback(
        async (payload, done) => {
          if (device === null) return
          setInputBusy(true)
          setInputError(null)
          try {
            await requestJson('/hdc/input', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ device, ...payload }),
            })
            setNote(done)
            // The screen moved because of this action; grab a frame now instead
            // of waiting up to a full poll interval.
            loadShot(true)
          } catch (error) {
            setNote(null)
            setInputError(messageOf(error))
          } finally {
            setInputBusy(false)
          }
        },
        [device, loadShot],
      )

      /**
       * Map a click on the <img> to device pixels.
       *
       * The picture is CSS-scaled (`max-width`/`max-height` keep the element box
       * equal to the drawn image, but that box is usually smaller than the PNG).
       * `naturalWidth`/`naturalHeight` are the PNG's own pixels, which the Host
       * captures at device resolution, so the per-axis display→natural ratio is
       * exactly the scale to undo. Per-axis on purpose: it stays correct even if
       * a future layout stretched the two axes differently.
       */
      function onShotClick(event) {
        const image = event.currentTarget
        if (device === null || inputBusy) return
        const box = image.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return
        const width = image.naturalWidth
        const height = image.naturalHeight
        if (width === 0 || height === 0) return
        const x = clamp(Math.round(((event.clientX - box.left) / box.width) * width), 0, width - 1)
        const y = clamp(Math.round(((event.clientY - box.top) / box.height) * height), 0, height - 1)
        sendInput({ action: 'click', x, y }, t('shot.tapDone', { x, y }))
      }

      /** Press one named device key (Back/Home/Power). */
      function pressKey(key, label) {
        sendInput({ action: 'key', key }, t('shot.keyDone', { key: label }))
      }

      // ── UI tree ────────────────────────────────────────────────────────────

      const loadTree = useCallback(async () => {
        if (device === null) return
        setTreeLoading(true)
        setTreeError(null)
        try {
          const body = await requestJson(withQuery('/hdc/uitree', { device, all_nodes: showAllNodes ? 1 : undefined }))
          setTree({
            device,
            allNodes: showAllNodes,
            rows: parseTreeRows(body?.content),
            truncated: body?.truncated === true,
            raw: typeof body?.content === 'string' ? body.content : '',
          })
        } catch (error) {
          setTreeError(messageOf(error))
        } finally {
          setTreeLoading(false)
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
        setLogsLoading(true)
        setLogsError(null)
        try {
          const body = await requestJson(withQuery('/hdc/logs', { device, crash: crashOnly ? 1 : undefined }))
          setLogs({
            device,
            crashOnly,
            content: typeof body?.content === 'string' ? body.content : '',
            matches: Number(body?.matches ?? 0),
            scanned: Number(body?.scanned ?? 0),
          })
        } catch (error) {
          setLogsError(messageOf(error))
        } finally {
          setLogsLoading(false)
        }
      }, [device, crashOnly])

      // Same shape as the tree effect: `logs` is listed so the read is not a
      // stale closure, and the early return prevents a reload loop.
      useEffect(() => {
        if (!logsOpen || device === null) return
        if (logs !== null && logs.device === device && logs.crashOnly === crashOnly) return
        loadLogs()
      }, [logsOpen, device, crashOnly, loadLogs, logs])

      /** Record the PNG's own pixel size once the browser knows it. */
      const noteShotSize = useCallback((image) => {
        if (image === null) return
        const width = image.naturalWidth
        const height = image.naturalHeight
        if (width === 0 || height === 0) return
        // Guarded so a cached frame that is already complete does not add an
        // extra render on every poll.
        setShotSize((current) => (current !== null && current.width === width && current.height === height ? current : { width, height }))
      }, [])

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
            toggleSwitch(t('auto.label'), autoRefresh, setAutoRefresh),
          ),
        )
      }

      /** The picture, or what stands in for it. */
      function renderStage() {
        if (device === null) {
          return h('div', { className: 'hdci-placeholder' }, t('device.none'))
        }
        if (shot !== null) {
          return h('img', {
            className: 'hdci-shot',
            src: shot.url,
            alt: t('title'),
            draggable: false,
            onClick: onShotClick,
            // A blob URL that is already decoded can be `complete` before React
            // attaches onLoad, in which case the caption would stay blank; the
            // ref callback covers that frame.
            ref: (image) => {
              if (image !== null && image.complete) noteShotSize(image)
            },
            onLoad: (event) => noteShotSize(event.currentTarget),
          })
        }
        if (shotError !== null) {
          return h(
            'div',
            { className: 'hdci-placeholder' },
            h('span', { className: 'hdci-errorbox' }, shotError),
            actionButton('retry-shot', t('error.retry'), () => loadShot(false), { disabled: shotLoading }),
          )
        }
        return h(
          'div',
          { className: 'hdci-placeholder' },
          h('span', { className: 'hdci-placeholder-title' }, shotLoading ? t('shot.loading') : t('shot.empty')),
        )
      }

      /** Status line under the picture: size, freshness, last action, errors. */
      function renderStageBar() {
        const parts = []
        if (shotSize !== null) parts.push(t('shot.size', { width: shotSize.width, height: shotSize.height }))
        if (shot !== null) parts.push(t('shot.updated', { time: clockOf(shot.at) }))
        if (busy) parts.push(t('action.busy'))
        return h(
          'div',
          { className: 'hdci-bar', 'aria-live': 'polite' },
          h('span', null, parts.join(' · ')),
          note === null ? null : h('span', { className: 'hdci-bar-note' }, note),
          shotError !== null && shot !== null ? h('span', { className: 'hdci-bar-error' }, t('shot.stale')) : null,
          inputError === null ? null : h('span', { className: 'hdci-bar-error' }, inputError),
        )
      }

      function renderActions() {
        const disabled = device === null || busy
        return h(
          'div',
          { className: 'hdci-actions' },
          actionButton('back', t('action.back'), () => pressKey('Back', t('action.back')), { disabled }),
          actionButton('home', t('action.home'), () => pressKey('Home', t('action.home')), { disabled }),
          actionButton('power', t('action.power'), () => pressKey('Power', t('action.power')), { disabled }),
          actionButton('refresh-shot', t('action.refreshShot'), () => loadShot(false), {
            variant: 'primary',
            disabled: device === null || shotLoading,
          }),
        )
      }

      /**
       * Text entry. `uitest uiInput text` writes into whatever field the device
       * has focused, so this row only sends the string: focus is set by tapping
       * the field in the screenshot first.
       */
      function renderTextRow() {
        const disabled = device === null || busy
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

      function renderTreeBody() {
        if (treeError !== null) return h('div', { className: 'hdci-error-inline' }, treeError)
        if (treeLoading && tree === null) return h('div', { className: 'hdci-note-inline' }, t('tree.loading'))
        if (tree === null) return h('div', { className: 'hdci-note-inline' }, t('tree.empty'))
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
                    disabled: busy,
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
            renderTextRow(),
            h('div', { className: 'hdci-bar' }, t('shot.tapHint')),
          ),
          renderSide(),
        )
      }

      /** Nothing attached: say what to do instead of showing empty controls. */
      function renderEmpty() {
        // A missing `hdcPath` is only a hint, not proof: the Host may simply
        // omit it. The device steps stay the primary message, and the hdc
        // suggestion is added underneath when the field is absent.
        const maybeNoHdc = hdcPath === null
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
