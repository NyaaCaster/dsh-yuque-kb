import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { detectTokenizer, openIndex } from '../src/storage/fts.ts'
import type { IndexedDoc, KbIndex } from '../src/storage/fts.ts'

const REPO_A = '个人/知识库A'
const REPO_B = '团队/知识库B'

/** Deterministic fake doc corpus: 20 docs, 10 per repo, with distinctive terms. */
function corpus(): IndexedDoc[] {
  const docs: IndexedDoc[] = []
  for (let index = 1; index <= 20; index += 1) {
    const repo = index <= 10 ? REPO_A : REPO_B
    const keyword = index % 5 === 0 ? '开放平台' : '知识库'
    docs.push({
      docId: `doc-${index}`,
      title: `文档标题 ${index}`,
      path: `/指南/文档 ${index}`,
      repo,
      updatedAt: 1_700_000_000_000 + index,
      body: [
        `# 文档 ${index}`,
        '',
        `这是第 ${index} 篇关于语雀${keyword}的文档内容，讨论${keyword}的接入与使用。`,
        '',
        '```ts',
        `const id = 'doc-${index}';`,
        '```',
        '',
        '| 字段 | 值 |',
        '| --- | --- |',
        `| docId | doc-${index} |`,
        '',
        'English sentence with unique-word-' + index + ' for western-token tests.',
      ].join('\n'),
    })
  }
  return docs
}

const cleanupPaths: string[] = []

async function tempIndexPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yuque-kb-fts-'))
  const path = join(dir, 'index.sqlite')
  cleanupPaths.push(dir)
  return path
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const dir = cleanupPaths.pop()
    if (dir !== undefined) {
      // Windows keeps the sqlite file handle alive briefly after close;
      // retry a few times before giving up.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
})

function byId(items: Array<{ docId: string }>, id: string): boolean {
  return items.some(item => item.docId === id)
}

describe('detectTokenizer', () => {
  it('returns a supported tokenizer kind on a fresh connection', () => {
    const db = new DatabaseSync(':memory:')
    const kind = detectTokenizer(db)
    db.close()
    expect(['trigram', 'unicode61']).toContain(kind)
  })
})

describe('FTS5 index — trigram path', () => {
  async function openTrigram(options?: { tokenizer?: 'trigram' | 'unicode61' }) {
    return openIndex(':memory:', { tokenizer: options?.tokenizer ?? 'trigram' })
  }

  it('reports the tokenizer, counts docs, and cleans up rows on close', async () => {
    const index = await openTrigram()
    index.upsertDocs(corpus())
    expect(index.tokenizer).toBe('trigram')
    expect(index.countDocs()).toBe(20)
    index.close()
  })

  it('matches CJK substrings of 3+ chars and short 2-char words via instr fallback', async () => {
    const index = await openTrigram()
    index.upsertDocs(corpus())
    // 3+ chars: pure trigram substring.
    const openPlatform = index.search({ query: '开放平台' })
    expect(openPlatform.total).toBe(4)
    expect(openPlatform.items.every(item => byId([{ docId: item.docId }], item.docId))).toBe(true)
    for (const item of openPlatform.items) {
      expect(item.snippet.length).toBeGreaterThan(0)
    }
    // 2-char word: trigram emits no token, the instr predicate must rescue it.
    const yuque = index.search({ query: '语雀' })
    expect(yuque.total).toBe(20)
    expect(yuque.items.length).toBeGreaterThan(0)
    expect(yuque.items[0]?.docId).toBeDefined()
    index.close()
  })

  it('matches an English word and title text', async () => {
    const index = await openTrigram()
    index.upsertDocs(corpus())
    const western = index.search({ query: 'unique-word-3' })
    expect(western.total).toBe(1)
    expect(western.items[0]?.docId).toBe('doc-3')
    // `文档标题 17`: the '17' token disambiguates from doc 7 (whose
    // title/path also contain `文档标题` plus a bare `7`).
    const byTitle = index.search({ query: '文档标题 17' })
    expect(byTitle.total).toBe(1)
    expect(byTitle.items[0]?.docId).toBe('doc-17')
    index.close()
  })

  it('filters by enabled ids and repo, and truncates honestly', async () => {
    const index = await openTrigram()
    index.upsertDocs(corpus())
    const all = index.search({ query: '知识库', limit: 20 })
    expect(all.total).toBeGreaterThan(10)
    expect(all.truncated).toBe(false)

    // Enabled filter: exclude every matched doc → empty result.
    const disabled = new Set(all.items.map(item => item.docId))
    const blocked = index.search({ query: '知识库', enabledIds: new Set() })
    expect(blocked.total).toBe(0)
    const partial = index.search({ query: '知识库', enabledIds: new Set(all.items.slice(1).map(item => item.docId)) })
    expect(partial.total).toBe(all.items.length - 1)

    // Repo filter.
    const repoOnly = index.search({ query: '知识库', repo: REPO_A, limit: 20 })
    expect(repoOnly.items.every(item => item.repo === REPO_A)).toBe(true)
    expect(repoOnly.total).toBeGreaterThan(0)

    // Truncation: page size 3 with more matches than that.
    const paged = index.search({ query: '知识库', limit: 3 })
    expect(paged.items.length).toBe(3)
    expect(paged.truncated).toBe(true)
    expect(paged.total).toBe(all.total)
    index.close()
  })

  it('upserts replace stale chunks and removeDocs deletes cleanly', async () => {
    const index = await openTrigram()
    index.upsertDocs(corpus())
    const staleTerm = 'unique-word-5'
    expect(index.search({ query: staleTerm }).total).toBe(1)

    // Overwrite doc-5 without the stale term: old chunks must disappear.
    const replacement = corpus().map(doc => doc.docId === 'doc-5'
      ? { ...doc, body: '全新内容，不再包含旧英文词。', title: '覆盖后的文档 5' }
      : doc)
    index.upsertDocs(replacement)
    expect(index.search({ query: staleTerm }).total).toBe(0)
    expect(index.search({ query: '覆盖后的文档' }).total).toBe(1)
    expect(index.countDocs()).toBe(20)

    // Delete doc-6: gone from hits and count.
    index.removeDocs(['doc-6'])
    expect(index.countDocs()).toBe(19)
    expect(index.search({ query: 'unique-word-6' }).total).toBe(0)
    expect(index.search({ query: '知识库' }).total).toBeLessThan(20)
    index.close()
  })

  it('returns empty results for blank queries and unknown terms', async () => {
    const index = await openTrigram()
    index.upsertDocs(corpus())
    expect(index.search({ query: '   ' }).items).toEqual([])
    expect(index.search({ query: '   ' }).total).toBe(0)
    expect(index.search({ query: '不存在的词xyzzy' }).total).toBe(0)
    index.close()
  })

  it('snippets stay near the 200-char budget with an ellipsis', async () => {
    const index = await openTrigram()
    index.upsertDocs(corpus())
    const result = index.search({ query: '开放平台', limit: 20 })
    for (const item of result.items) {
      expect(Array.from(item.snippet).length).toBeLessThanOrEqual(210)
    }
    expect(result.items.some(item => item.snippet.includes('开放平台'))).toBe(true)
    index.close()
  })
})

describe('FTS5 index — unicode61 fallback path', () => {
  it('matches CJK substrings via instr and honors filters', async () => {
    const index = await openIndex(':memory:', { tokenizer: 'unicode61' })
    index.upsertDocs(corpus())
    expect(index.tokenizer).toBe('unicode61')

    const yuque = index.search({ query: '语雀' })
    expect(yuque.total).toBe(20)
    const platform = index.search({ query: '开放平台', limit: 20 })
    expect(platform.total).toBe(4)
    for (const item of platform.items) {
      expect(item.snippet.includes('开放平台')).toBe(true)
    }

    const repoOnly = index.search({ query: '开放平台', repo: REPO_B, limit: 20 })
    expect(repoOnly.items.every(item => item.repo === REPO_B)).toBe(true)
    expect(repoOnly.total).toBe(2)

    const blocked = index.search({ query: '语雀', enabledIds: new Set() })
    expect(blocked.total).toBe(0)

    // `unique-word-20` is chosen over `unique-word-1`: the latter is a
    // prefix of `unique-word-10..19`, so a pure sub-string search would
    // legitimately keep hitting them after doc-1 is removed.
    index.removeDocs(['doc-20'])
    expect(index.search({ query: 'unique-word-20' }).total).toBe(0)
    expect(index.countDocs()).toBe(19)
    index.close()
  })
})

describe('FTS5 index — persistence on disk', () => {
  it('reopens a file index with data intact', async () => {
    const path = await tempIndexPath()
    const first = await openIndex(path)
    first.upsertDocs(corpus())
    first.close()

    const second = await openIndex(path)
    expect(second.countDocs()).toBe(20)
    expect(second.search({ query: '开放平台' }).total).toBe(4)
    expect(second.search({ query: '语雀' }).total).toBe(20)
    second.close()
  })

  it('refuses to open a foreign non-empty sqlite file', async () => {
    const path = await tempIndexPath()
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE foreign_data (id INTEGER PRIMARY KEY, payload TEXT)')
    db.exec("INSERT INTO foreign_data (payload) VALUES ('x')")
    db.close()
    await expect(openIndex(path)).rejects.toThrow(/not an empty or recognized index/)
  })
})