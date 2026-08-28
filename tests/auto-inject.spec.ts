import { describe, expect, it } from 'vitest'
import { extractQueryTokens, tryAutoInjection } from '../src/auto-inject.ts'
import type { KbEngine } from '../src/engine.ts'

/** Minimal engine stub for pure-logic tests. */
function stubEngine(overrides: Partial<Pick<KbEngine, 'search' | 'read' | 'searchRemote' | 'readByRef'>>): KbEngine {
  return {
    resolveToken: () => 't',
    saveRuntimeToken: async () => {},
    testConnection: async () => ({ ok: true, user: { login: 'me', name: 'Me', booksCount: 1 } }),
    sync: async () => ({ synced: 0, added: 0, updated: 0, removed: 0, errors: [], rateRemaining: 5000 }),
    refreshCatalog: async () => {},
    tree: () => ({ repos: [], lastSyncAt: null, rateRemaining: null }),
    toggle: async () => true,
    status: () => ({ syncing: false, lastSyncAt: null, rateRemaining: null, errors: [], tokenConfigured: true }),
    search: () => ({ total: 0, truncated: false, items: [] }),
    read: async () => ({ docId: '', title: '', repo: '', totalBlocks: 0, startBlock: 0, nextCursor: null, blocks: [] }),
    readByRef: async () => ({ title: '', repo: '', totalBlocks: 0, blocks: [] }),
    searchRemote: async () => ({ total: 0, items: [] }),
    rateRemaining: () => 5000,
    ...overrides,
  } as KbEngine
}

const OPTIONS = { enabled: true, autoInjectRemote: true, intervalMs: 30_000, minQueryChars: 8 }

describe('extractQueryTokens', () => {
  it('extracts CJK runs and ASCII words', () => {
    expect(extractQueryTokens('我想了解酒馆配置和 alpha-beta 的用法'))
      .toEqual(['我想了解酒馆配置和', '的用法', 'alpha-beta'])
  })

  it('keeps tokens unique and skips short fragments', () => {
    expect(extractQueryTokens('a ab abc 中 中文')).toEqual(['中文', 'abc'])
  })

  it('returns nothing for pure number/punctuation text', () => {
    expect(extractQueryTokens('123 456')).toEqual([])
  })
})

describe('tryAutoInjection', () => {
  it('injects a local catalogue hit with its live body', async () => {
    const message = '帮我看看如何配置酒馆的部署手册内容'
    const engine = stubEngine({
      search: (query) => {
        if (query.includes('酒馆') || query.includes('部署')) {
          // Real-engine invariant: a local hit's title/path always contains
          // the queried token (substring matching).
          return { total: 1, truncated: false, items: [{ docId: '11', title: `酒馆部署手册${query}`, path: `运维/部署手册${query}`.slice(0, 6), repo: 'me/book1', updatedAt: 1 }] }
        }
        return { total: 0, truncated: false, items: [] }
      },
      read: async () => ({
        docId: '11', title: '酒馆部署手册', repo: 'me/book1', totalBlocks: 5, startBlock: 0, nextCursor: 4,
        blocks: [{ type: 'heading', text: '# 酒馆部署手册' }, { type: 'paragraph', text: '第一步安装酒馆服务端' }],
      }),
    })
    const injected = await tryAutoInjection(engine, message, OPTIONS)
    expect(injected).toContain('[yuque-kb-auto]')
    expect(injected).toContain('酒馆部署手册')
    expect(injected).toContain('第一步安装酒馆服务端')
    expect(injected).toContain('me/book1')
  })

  it('falls back to the cloud search when the catalogue misses', async () => {
    const engine = stubEngine({
      searchRemote: async () => ({
        total: 1,
        items: [{
          docId: '99', title: 'Gemini 预设', repo: 'me/other', url: '/me/other/doc-gemini', summary: '这是一个破限预设',
        }],
      }),
      readByRef: async () => ({
        title: 'Gemini 预设', repo: 'me/other', totalBlocks: 2,
        blocks: [{ type: 'heading', text: '# Gemini 预设' }, { type: 'paragraph', text: '正文内容片段' }],
      }),
    })
    const injected = await tryAutoInjection(engine, '怎么调 gemini 破限预设的效果', OPTIONS)
    expect(injected).toContain('[yuque-kb-auto]')
    expect(injected).toContain('Gemini 预设')
    expect(injected).toContain('正文内容片段')
  })

  it('stays silent when nothing matches and when the cloud probe fails', async () => {
    const miss = await tryAutoInjection(
      stubEngine({ searchRemote: async () => ({ total: 0, items: [] }) }),
      '帮我写一段 python 脚本处理 csv 文件', OPTIONS,
    )
    expect(miss).toBeUndefined()

    const failing = await tryAutoInjection(
      stubEngine({ searchRemote: async () => { throw new Error('rate-limited') } }),
      '帮我写一段 python 脚本处理 csv 文件', OPTIONS,
    )
    expect(failing).toBeUndefined()
  })

  it('respects the remote probe switch', async () => {
    const engine = stubEngine({
      searchRemote: async () => ({ total: 1, items: [{ docId: '9', title: 'X', repo: 'me/x', url: '/me/x/x', summary: 's' }] }),
    })
    const injected = await tryAutoInjection(engine, '帮我写一段 python 脚本处理 csv 文件', { ...OPTIONS, autoInjectRemote: false })
    expect(injected).toBeUndefined()
  })
})