/**
 * Incremental doc diff unit tests (pure, no IO).
 */
import { describe, expect, it } from 'vitest'

import { diffDocs } from '../../src/yuque/diff.ts'
import type { DocDiff, DocRef } from '../../src/yuque/types.ts'

function slugs(diff: DocDiff): Record<keyof DocDiff, string[]> {
  return {
    added: diff.added.map((r) => r.slug),
    updated: diff.updated.map((r) => r.slug),
    unchanged: diff.unchanged.map((r) => r.slug),
    removed: diff.removed.map((r) => r.slug),
  }
}

describe('diffDocs', () => {
  it('handles both empty lists', () => {
    expect(slugs(diffDocs([], []))).toEqual({ added: [], updated: [], unchanged: [], removed: [] })
  })

  it('marks everything added when the local list is empty', () => {
    const remote: DocRef[] = [
      { slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z' },
      { slug: 'b', updatedAt: '2026-08-02T00:00:00.000Z' },
    ]
    expect(slugs(diffDocs([], remote))).toEqual({
      added: ['a', 'b'],
      updated: [],
      unchanged: [],
      removed: [],
    })
  })

  it('marks everything removed when the remote list is empty', () => {
    const local: DocRef[] = [{ slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z' }]
    expect(slugs(diffDocs(local, []))).toEqual({
      added: [],
      updated: [],
      unchanged: [],
      removed: ['a'],
    })
  })

  it('keeps docs with equal timestamps unchanged', () => {
    const local: DocRef[] = [{ slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z' }]
    const remote: DocRef[] = [{ slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z' }]
    expect(slugs(diffDocs(local, remote))).toEqual({
      added: [],
      updated: [],
      unchanged: ['a'],
      removed: [],
    })
  })

  it('marks newer remote timestamps as updated and keeps others unchanged', () => {
    const local: DocRef[] = [
      { slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z' },
      { slug: 'b', updatedAt: '2026-08-01T00:00:00.000Z' },
    ]
    const remote: DocRef[] = [
      { slug: 'a', updatedAt: '2026-08-03T00:00:00.000Z' },
      { slug: 'b', updatedAt: '2026-08-01T00:00:00.000Z' },
    ]
    expect(slugs(diffDocs(local, remote))).toEqual({
      added: [],
      updated: ['a'],
      unchanged: ['b'],
      removed: [],
    })
  })

  it('treats remote docs without a timestamp as updated (cannot prove equality)', () => {
    const local: DocRef[] = [{ slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z' }]
    const remote: DocRef[] = [{ slug: 'a' }]
    expect(slugs(diffDocs(local, remote))).toEqual({
      added: [],
      updated: ['a'],
      unchanged: [],
      removed: [],
    })
  })

  it('detects removal alongside addition and update in one pass', () => {
    const local: DocRef[] = [
      { slug: 'keep', updatedAt: '2026-08-01T00:00:00.000Z' },
      { slug: 'change', updatedAt: '2026-08-01T00:00:00.000Z' },
      { slug: 'gone', updatedAt: '2026-08-01T00:00:00.000Z' },
    ]
    const remote: DocRef[] = [
      { slug: 'keep', updatedAt: '2026-08-01T00:00:00.000Z' },
      { slug: 'change', updatedAt: '2026-08-02T00:00:00.000Z' },
      { slug: 'brand-new', updatedAt: '2026-08-05T00:00:00.000Z' },
    ]
    expect(slugs(diffDocs(local, remote))).toEqual({
      added: ['brand-new'],
      updated: ['change'],
      unchanged: ['keep'],
      removed: ['gone'],
    })
  })

  it('carries remote refs in added/updated and local refs in removed', () => {
    const local: DocRef[] = [
      { slug: 'changed', updatedAt: 'old-ts' },
      { slug: 'deleted', updatedAt: 'local-ts' },
    ]
    const remote: DocRef[] = [
      { slug: 'changed', updatedAt: 'new-ts' },
      { slug: 'fresh', updatedAt: 'fresh-ts' },
    ]
    const diff = diffDocs(local, remote)
    expect(diff.updated[0]?.updatedAt).toBe('new-ts')
    expect(diff.added[0]?.updatedAt).toBe('fresh-ts')
    expect(diff.removed[0]?.updatedAt).toBe('local-ts')
  })
})