/**
 * Host half of the HarmonyOS hdc tools bundle.
 *
 * The plugin only registers tools; every device interaction happens inside a
 * tool call, so nothing runs while the model is idle.
 *
 * @module hdc-tools
 */

import { registerTools } from './tools.js'

export const name = 'hdc-tools'

/** Tool registration is the only Host capability this plugin needs. */
export const inject = ['tools']

/** Settings this plugin reads, all optional. */
const CONFIG_KEYS = ['hdcPath', 'downloadDir']

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
 * Register the tool family.
 * @param ctx - plugin context.
 * @param config - loader config for this row, already validated when the Loader
 *   applied `Config`; normalized again because a direct caller may not have.
 */
export function apply(ctx, config) {
  registerTools(ctx, normalizeConfig(config))
}
