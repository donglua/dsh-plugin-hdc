/**
 * Artifacts a panel action produced: a still, or a recording.
 *
 * The panel runs in the page's own origin and cannot open a local file, so a
 * capture or a recording needs a URL to be downloaded from. Handing out the
 * file's path would be a path-traversal primitive over HTTP; handing out an
 * opaque id that maps to a path the Host itself chose is not.
 *
 * The registry is deliberately in memory and small. These are the last few
 * things a user just made in the panel, not a library: a Host restart drops
 * them, and the file is still on disk at the path the panel reported.
 *
 * @module hdc-tools/artifacts
 */

import { randomUUID } from 'node:crypto'

/** How many artifacts stay downloadable; oldest is dropped first. */
const CAPACITY = 24

/** id → entry, in insertion order. */
const entries = new Map()

/**
 * Remember one file and return the id that serves it.
 *
 * @param entry.path - absolute local path the Host wrote.
 * @param entry.mediaType - type to answer with.
 * @param entry.name - download name shown to the user.
 * @param entry.kind - what made it, so the panel can name it.
 * @returns the opaque id.
 */
export function remember(entry) {
  const id = randomUUID()
  entries.set(id, { ...entry, at: Date.now() })
  // A Map iterates in insertion order, so the first key is the oldest.
  while (entries.size > CAPACITY) {
    const oldest = entries.keys().next()
    if (oldest.done === true) break
    entries.delete(oldest.value)
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
}
