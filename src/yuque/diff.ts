/**
 * Incremental doc diff (pure, IO-free).
 *
 * Compares the locally stored doc list against the remote doc list by
 * `slug` + change timestamp, so sync only re-fetches what actually changed.
 */

import type { DocDiff, DocRef } from './types.ts'

/**
 * Compare local (last-synced) doc refs against remote refs.
 *
 * - added:      remote-only slugs
 * - updated:    same slug, remote `updatedAt` strictly newer than local
 * - unchanged:  same slug, same timestamp
 * - removed:    local-only slugs
 *
 * A remote ref with a missing timestamp is treated as updated (we cannot
 * prove equality), keeping the sync safe on the "re-fetch" side.
 */
export function diffDocs(local: DocRef[], remote: DocRef[]): DocDiff {
  const localBySlug = new Map(local.map((ref) => [ref.slug, ref]))
  const remoteBySlug = new Map(remote.map((ref) => [ref.slug, ref]))

  const added: DocRef[] = []
  const updated: DocRef[] = []
  const unchanged: DocRef[] = []
  const removed: DocRef[] = []

  for (const localRef of local) {
    const remoteRef = remoteBySlug.get(localRef.slug)
    if (remoteRef === undefined) {
      removed.push(localRef)
      continue
    }
    if (isNewer(remoteRef.updatedAt, localRef.updatedAt)) {
      updated.push(remoteRef)
    } else {
      unchanged.push(remoteRef)
    }
  }
  for (const remoteRef of remote) {
    if (!localBySlug.has(remoteRef.slug)) added.push(remoteRef)
  }

  return { added, updated, unchanged, removed }
}

/** True when `remote` is strictly newer than `local` (missing remote = newer). */
function isNewer(remote: string | undefined, local: string | undefined): boolean {
  if (remote === undefined) return true
  if (local === undefined) return true
  const remoteMs = Date.parse(remote)
  const localMs = Date.parse(local)
  if (Number.isNaN(remoteMs) || Number.isNaN(localMs)) {
    // Unparsable timestamps: fall back to raw inequality (safe = re-fetch).
    return remote !== local
  }
  return remoteMs > localMs
}