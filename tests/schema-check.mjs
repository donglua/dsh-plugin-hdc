/**
 * Validate every registered tool against DSH's own schema assertion.
 *
 * The tools are registered as raw definitions, so a stray schema keyword would
 * only fail at first use. This runs the real assertion from the installed
 * harness instead of a local approximation.
 *
 *   ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/schema-check.mjs
 *
 * The harness package lives inside app.asar, so it is reachable only through the
 * Electron Node runtime; the script path goes straight to the executable.
 */

// Resolve the harness package from the running installation, which lives inside
// app.asar and so is reachable only through the Electron Node runtime.
const toolsPackage = process.env.DSH_INSTALL_DIR === undefined
  ? '@deepseek-ai/dsh-tools'
  : `file://${process.env.DSH_INSTALL_DIR}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`
const { assertSupportedJsonSchema, assertObjectJsonSchema } = await import(toolsPackage)
import { registerTools } from '../lib/tools.js'
import { Config } from '../lib/index.js'

const registered = new Map()
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  get: () => undefined,
}

registerTools(ctx, {})

let failed = false
for (const [name, definition] of registered) {
  try {
    assertObjectJsonSchema(definition.parameters, `${name}.parameters`)
    assertSupportedJsonSchema(definition.output.schema, `${name}.output.schema`)
    console.log(`ok  ${name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

// The Loader validates a row with `Config['~standard'].validate`, synchronously.
const standard = Config?.['~standard']
if (standard === undefined) {
  failed = true
  console.error('FAIL Config: no ~standard schema')
} else if (standard.version !== 1 || typeof standard.validate !== 'function') {
  failed = true
  console.error('FAIL Config: not a version 1 Standard Schema')
} else if ('then' in standard.validate({})) {
  failed = true
  console.error('FAIL Config: validate must be synchronous')
} else if (standard.validate({ hdcPath: ' /x/hdc ' }).value.hdcPath !== '/x/hdc') {
  failed = true
  console.error('FAIL Config: does not trim values')
} else if (standard.validate({ hdcPath: 5 }).issues === undefined) {
  failed = true
  console.error('FAIL Config: accepts a non-string hdcPath')
} else if (standard.validate({ remoteAddress: ' phone.local:8710 ' }).value.remoteAddress !== 'phone.local:8710') {
  failed = true
  console.error('FAIL Config: does not preserve a trimmed remoteAddress')
} else if (standard.validate({ remoteAddress: 'http://phone.local' }).issues === undefined) {
  failed = true
  console.error('FAIL Config: accepts a malformed remoteAddress')
} else {
  console.log('ok  Config')
}

if (registered.size === 0) {
  console.error('no tools were registered')
  process.exitCode = 1
} else if (failed) {
  process.exitCode = 1
} else {
  console.log(`\n${registered.size} tool definitions satisfy the harness schema subset`)
}
