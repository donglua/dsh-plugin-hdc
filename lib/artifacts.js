/**
 * Artifacts a panel action produced: a still, or a recording.
 *
 * The panel runs in the page's own origin and cannot open a local file, so what
 * it makes has to be reachable over HTTP to be copied or saved. Handing out the
 * file's path would be a path-traversal primitive; handing out an opaque id that
 * maps to bytes the Host itself holds is not.
 *
 * Two kinds of entry live here. A still is usually *bytes in memory*: the panel
 * copies it to the clipboard, which needs no file on disk, and writing one into
 * the profile directory on every press was litter nobody asked for. A recording
 * is always a file — there is nothing to paste — and a still is a file too when
 * `downloadDir` names where captures belong.
 *
 * The registry is deliberately in memory and small: these are the last few
 * things a user just made, not a library. A Host restart drops them, and a file
 * that was written is still on disk at the path the panel reported.
 *
 * @module hdc-tools/artifacts
 */

import { randomUUID } from 'node:crypto'

/** How many artifacts stay downloadable; oldest is dropped first. */
const CAPACITY = 24

/**
 * How many in-memory bytes are kept for captured stills.
 *
 * A device screenshot is a few hundred kilobytes, so this holds a comfortable
 * handful. It bounds Host memory rather than counting entries: twenty-four
 * recordings would be gigabytes, and only the stills are ever held as bytes.
 */
export const MAX_INLINE_BYTES = 64 * 1024 * 1024

/** id → entry, in insertion order. */
const entries = new Map()

/** Total bytes currently held by entries that carry `data`. */
let inlineBytes = 0

/** Drop one entry and its share of the inline byte budget. */
function forget(id) {
  const entry = entries.get(id)
  if (entry === undefined) return
  entries.delete(id)
  if (entry.data !== undefined) inlineBytes -= entry.data.byteLength
}

/**
 * Remember one artifact and return the id that serves it.
 *
 * @param entry.path - absolute local path, for an artifact the Host wrote.
 * @param entry.data - the bytes themselves, for one it only holds in memory.
 *   Exactly one of `path` or `data` is set.
 * @param entry.mediaType - type to answer with.
 * @param entry.name - download name shown to the user.
 * @param entry.kind - what made it, so the panel can name it.
 * @returns the opaque id.
 */
export function remember(entry) {
  if (entry.data === undefined && entry.path === undefined) {
    throw new TypeError('an artifact needs either bytes or a path')
  }
  const id = randomUUID()
  entries.set(id, { ...entry, at: Date.now() })
  if (entry.data !== undefined) inlineBytes += entry.data.byteLength
  // A Map iterates in insertion order, so the first key is the oldest. Stills
  // held as bytes also push the older ones out early: the newest capture is the
  // one the user is about to paste, and keeping an old recording's budget is not
  // worth refusing it.
  while (entries.size > CAPACITY) {
    const oldest = entries.keys().next()
    if (oldest.done === true) break
    forget(oldest.value)
  }
  while (inlineBytes > MAX_INLINE_BYTES) {
    let dropped = false
    for (const [key, value] of entries) {
      if (value.data === undefined) continue
      forget(key)
      dropped = true
      break
    }
    // Only files are left, which cost no budget to keep.
    if (!dropped) break
  }
  return id
}

/** The artifact behind one id, or `undefined` when it was never minted. */
export function recall(id) {
  return typeof id === 'string' ? entries.get(id) : undefined
}

/** Drop every artifact, for a test that needs a clean slate. */
export function clear() {
  entries.clear()
  inlineBytes = 0
}
