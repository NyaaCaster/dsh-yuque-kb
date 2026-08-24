import { describe, expect, it } from 'vitest'
import { DomainError } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  DOMAIN_NAME,
  getDoc,
  getGlobal,
  getRepo,
  kbDomainSpec,
  setDoc,
  setEnabled,
  setGlobal,
  setRepo,
} from '../src/storage/domain.ts'
import type { DocId, DocRecord, KbDomain, KbGlobal, RepoId, RepoRecord } from '../src/storage/domain.ts'

/**
 * In-memory KvTable double sharing the real `KvTable` interface; gets re-checked
 * against a real `Domain` handle at P4 integration time. The domain helpers in
 * `src/storage/domain.ts` are injection-friendly by design (they take the open
 * handle, not a cordis context), so construction without a storage backend
 * exercises the same code path the P4 host apply will use.
 */
function createMemoryTable<K extends string, V>(): KvTable<K, V> {
  const records = new Map<K, V>()
  return {
    get: key => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() {
      return records.size
    },
    put: async (key, value) => {
      records.set(key, value)
    },
    delete: async key => records.delete(key),
    update: async (key, fn) => {
      const current = records.get(key)
      if (current === undefined) {
        throw new DomainError('missing-key', `no record '${key}' to update`)
      }
      const next = fn(current)
      records.set(key, next)
      return next
    },
  }
}

/** Build a fake opened `yuque-kb` domain over two memory tables. */
function createFakeDomain(): { domain: KbDomain; repos: KvTable<RepoId, RepoRecord>; docs: KvTable<DocId, DocRecord> } {
  const repos = createMemoryTable<RepoId, RepoRecord>()
  const docs = createMemoryTable<DocId, DocRecord>()
  let globalValue: KbGlobal = { lastSyncAt: null, rateRemaining: null }
  return {
    repos,
    docs,
    domain: {
      name: DOMAIN_NAME,
      global: {
        get: () => globalValue,
        set: async (value: KbGlobal) => {
          globalValue = value
        },
      },
      table: (name: string) => (name === 'repos' ? repos : docs),
      close: async () => {},
    } as unknown as KbDomain,
  }
}

function repoRecord(overrides?: Partial<RepoRecord>): RepoRecord {
  return {
    namespace: 'hony-wen',
    name: '测试知识库',
    type: 'Book',
    enabled: true,
    team: null,
    updatedAt: 1_700_000_000_000,
    itemsCount: 3,
    ...overrides,
  }
}

function docRecord(overrides?: Partial<DocRecord>): DocRecord {
  return {
    repoId: 'repo-1' as RepoId,
    slug: 'guide',
    title: '使用指南',
    path: '/测试知识库/使用指南',
    enabled: true,
    updatedAt: 1_700_000_000_000,
    wordCount: 1200,
    blocks: 8,
    format: 'md',
    ...overrides,
  }
}

describe('kbDomainSpec', () => {
  it('declares the SSOT §3.3 layout: global + repos + docs, version 1', () => {
    // Unit-name grammar forbids hyphens; see DOMAIN_NAME docs for the
    // `yuque-kb` vs `yuque_kb` note.
    expect(kbDomainSpec.name).toBe('yuque_kb')
    expect(kbDomainSpec.version).toBe(1)
    expect(kbDomainSpec.global).toBeDefined()
    expect(Object.keys(kbDomainSpec.tables).sort()).toEqual(['docs', 'repos'])
  })

  it('rejects a global schema that accepts null (domain invariant)', () => {
    // The built-in guard is exercised through a fresh spec to prove the
    // canonical one stays free of the never-written sentinel collision.
    expect(kbDomainSpec.global?.schema.safeParse(null).success).toBe(false)
  })
})

describe('repo helpers', () => {
  it('round-trips a repo record through setRepo/getRepo', async () => {
    const { domain, repos } = createFakeDomain()
    const id = 'repo-1' as RepoId
    expect(getRepo(domain, id)).toBeUndefined()
    await setRepo(domain, id, repoRecord())
    expect(getRepo(domain, id)).toEqual(repoRecord())
    expect(repos.size).toBe(1)
  })

  it('replaces an existing record on second setRepo', async () => {
    const { domain } = createFakeDomain()
    const id = 'repo-1' as RepoId
    await setRepo(domain, id, repoRecord({ name: '旧名' }))
    await setRepo(domain, id, repoRecord({ name: '新名', enabled: false }))
    expect(getRepo(domain, id)).toMatchObject({ name: '新名', enabled: false })
  })
})

describe('doc helpers', () => {
  it('round-trips a doc record through setDoc/getDoc', async () => {
    const { domain, docs } = createFakeDomain()
    const id = 'doc-1' as DocId
    expect(getDoc(domain, id)).toBeUndefined()
    await setDoc(domain, id, docRecord())
    expect(getDoc(domain, id)).toEqual(docRecord())
    expect(docs.size).toBe(1)
  })
})

describe('setEnabled', () => {
  it('flips the repo flag atomically', async () => {
    const { domain } = createFakeDomain()
    const id = 'repo-1' as RepoId
    await setRepo(domain, id, repoRecord())
    expect(await setEnabled(domain, 'repo', id, false)).toBe(true)
    expect(getRepo(domain, id)?.enabled).toBe(false)
    expect(await setEnabled(domain, 'repo', id, true)).toBe(true)
    expect(getRepo(domain, id)?.enabled).toBe(true)
  })

  it('flips the doc flag atomically without touching other fields', async () => {
    const { domain } = createFakeDomain()
    const id = 'doc-1' as DocId
    await setDoc(domain, id, docRecord())
    await setEnabled(domain, 'doc', id, false)
    expect(getDoc(domain, id)).toMatchObject({ enabled: false, title: '使用指南' })
  })

  it('returns false and writes nothing for a missing record', async () => {
    const { domain, docs, repos } = createFakeDomain()
    expect(await setEnabled(domain, 'repo', 'nope' as RepoId, false)).toBe(false)
    expect(await setEnabled(domain, 'doc', 'nope' as DocId, false)).toBe(false)
    expect(repos.size).toBe(0)
    expect(docs.size).toBe(0)
  })
})

describe('global helpers', () => {
  it('starts at the initial value and round-trips setGlobal/getGlobal', async () => {
    const { domain } = createFakeDomain()
    expect(getGlobal(domain)).toEqual({ lastSyncAt: null, rateRemaining: null })
    await setGlobal(domain, { lastSyncAt: 1_700_000_001_000, rateRemaining: 88 })
    expect(getGlobal(domain)).toEqual({ lastSyncAt: 1_700_000_001_000, rateRemaining: 88 })
  })
})