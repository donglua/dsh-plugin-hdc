/**
 * Host half of the HarmonyOS hdc tools bundle.
 *
 * The plugin only registers tools; every device interaction happens inside a
 * tool call, so nothing runs while the model is idle.
 *
 * @module hdc-tools
 */

import { createHandler, ROUTE_PREFIX } from './routes.js'
import { registerTools } from './tools.js'

export const name = 'hdc-tools'

/**
 * The tools need the tool registry. The webserver is claimed separately.
 *
 * `webServer` is deliberately *not* in this array. Cordis treats every name
 * here as a hard requirement: it parks the whole plugin in PENDING and never
 * calls `apply` while one is missing, which would silently remove the device
 * tools from any profile without a browser surface (a CLI profile). The routes
 * are claimed with `ctx.inject(['webServer'], …)` below instead, so they start
 * when a webserver appears and cost nothing when none ever does.
 */
export const inject = ['tools']

/** Settings this plugin reads, all optional. */
const CONFIG_KEYS = ['hdcPath', 'downloadDir', 'ffmpegPath']

/**
 * Keep only the settings this plugin reads, trimmed, so a malformed row cannot
 * make a tool fail halfway through a device call.
 * @param source - untrusted loader config.
 * @returns the resolved config.
 */
function normalizeConfig(source) {
  const input = source ?? {}
  const resolved = {}
  for (const key of CONFIG_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') resolved[key] = value.trim()
  }
  return resolved
}

/**
 * Config row schema, in the Standard Schema form the Loader validates with.
 *
 * Written by hand rather than with `@deepseek-ai/schemastery` so the bundle
 * keeps its promise of installing from a plain directory with no dependency and
 * no build step. Both settings are optional; a non-string value is reported
 * with the field it belongs to instead of being silently ignored.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-plugin-hdc',
    validate(value) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'the hdc-tools config must be an object' }] }
      }
      const issues = []
      for (const key of CONFIG_KEYS) {
        const field = value[key]
        if (field !== undefined && field !== null && typeof field !== 'string') {
          issues.push({ message: `${key} must be a string`, path: [key] })
        }
      }
      if (issues.length > 0) return { issues }
      return { value: normalizeConfig(value) }
    },
  }),
})

/**
 * Register the tool family, and the HTTP routes when a webserver is mounted.
 * @param ctx - plugin context.
 * @param config - loader config for this row, already validated when the Loader
 *   applied `Config`; normalized again because a direct caller may not have.
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  registerTools(ctx, resolved)

  const mounted = (webServer) => webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createHandler({ config: resolved }),
  })

  ctx.effect(() => {
    // Already mounted: register now, which is the common case and also the only
    // path a plain context (a test, another host) can take.
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) return mounted(webServer)
    // Not mounted yet: a plain context cannot express "later", so stop here and
    // keep the tools; a real context defers through `ctx.inject`, which also
    // covers a composition that provides the webserver after this plugin loads.
    if (typeof ctx.inject !== 'function') return undefined
    return ctx.inject(['webServer'], (inner) => mounted(inner.webServer))
  }, 'hdc-tools.routes')
}
