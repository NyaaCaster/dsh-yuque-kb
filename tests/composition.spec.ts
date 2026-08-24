/**
 * REAL-composition tests (harness policy: a product-visible plugin boots a
 * real cordis composition; only external services and nondeterministic inputs
 * are mocked). This suite assembles the plugin over the real services (tools,
 * systemPrompt, webServer, storage hub + domain layer with an in-memory kv
 * backend), mocks the Yuque HTTP surface through global fetch, and asserts
 * model-visible outputs (tool render text, the announcement prompt section),
 * durable state (domain + FTS index through the tools), user-visible route
 * payloads, and fiber-dispose cleanup (HMR safety).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { StorageBackend, KvFacet, KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Config } from '../src/index.ts'
import * as YuqueKb from '../src/index.ts'
import { CallId } from '@deepseek-ai/dsh-llm/brand'

// ---------------------------------------------------------------------------
// Yuque HTTP mock (whole account: 1 personal repo, 2 docs).
// ---------------------------------------------------------------------------

const USER = { id: 100, login: 'me', name: 'Me', books_count: 1, public_books_count: 0 }
const REPO_1 = {
  id: 1, type: 'Book', slug: 'book1', name: 'Book One', namespace: 'me/book1',
  items_count: 2, content_updated_at: '2026-08-01T00:00:00.000Z', public: true,
}
const TOC_1 = [
  { uuid: 'g1', type: 'TITLE', title: '指南', level: 1 },
  { uuid: 'd1', type: 'DOC', title: 'Doc A', slug: 'doc-a', doc_id: 11, level: 2, parent_uuid: 'g1' },
  { uuid: 'd2', type: 'DOC', title: 'Doc B', slug: 'doc-b', doc_id: 12, level: 1 },
]
const DOCS_1 = [
  { id: 11, slug: 'doc-a', title: 'Doc A', book_id: 1, content_updated_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' },
  { id: 12, slug: 'doc-b', title: 'Doc B', book_id: 1, content_updated_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' },
]
const BODY_A = '# Doc A\n\n这是第一段语雀文档内容，包含关键术语 alpha-beta 与配置示例。\n\n```ts\nconst alpha = 1\n```'
const BODY_B = '# Doc B\n\n另一篇文档，讨论 beta 模式与语雀知识库使用。'

/** One pathname → responder table; missing keys fail the test loudly. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function rateHeaders(): Record<string, string> {
  return { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900' }
}

/** The mocked Yuque HTTP surface (registered under global fetch). */
function createYuqueMock(): { fetch: typeof fetch; calls: Array<{ pathname: string; query: string; token?: string }> } {
  const calls: Array<{ pathname: string; query: string; token?: string }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    calls.push({
      pathname: url.pathname,
      query: url.search,
      token: new Headers(init?.headers).get('x-auth-token') ?? undefined,
    })
    const ok = (data: unknown, extraHeaders: Record<string, string> = {}): Response =>
      jsonResponse({ data }, 200, { ...rateHeaders(), ...extraHeaders })
    const withMeta = (data: unknown, meta: Record<string, unknown>): Response =>
      jsonResponse({ data, meta }, 200, rateHeaders())

    const path = url.pathname
    const query = url.searchParams
    if (path === '/api/v2/hello') return ok({ message: 'Hello' })
    if (path === '/api/v2/user') return ok(USER)
    if (path === '/api/v2/users/me/repos') return ok([REPO_1])
    if (path === '/api/v2/repos/me/book1/toc') return ok(TOC_1)
    if (path === '/api/v2/repos/me/book1/docs' && query.get('offset') === '0') {
      return withMeta(DOCS_1, { total: 2 })
    }
    if (path === '/api/v2/repos/me/book1/docs/doc-a') {
      const detail = { id: 11, slug: 'doc-a', title: 'Doc A', book_id: 1, format: 'markdown', body: BODY_A }
      return ok(query.has('raw') ? detail : detail)
    }
    if (path === '/api/v2/repos/me/book1/docs/doc-b') {
      const detail = { id: 12, slug: 'doc-b', title: 'Doc B', book_id: 1, format: 'markdown', body: BODY_B }
      return ok(detail)
    }
    if (path === '/api/v2/search') {
      return jsonResponse({
        meta: { total: 3, pageNo: 1, pageSize: 20 },
        data: [
          {
            id: 31, type: 'doc', title: '酒<em>馆</em>配置', summary: '一段 <em>高亮</em> 摘要',
            url: '/me/book1/doc-x', info: 'Me / Book One', target: { id: 31, slug: 'doc-x' },
          },
          {
            id: 32, type: 'doc', title: '第二<em>命中</em>', summary: '团队库命中',
            url: '/g-team/tbook/doc-y', info: 'G Team / Team Book', target: { id: 32, slug: 'doc-y' },
          },
          {
            id: 33, type: 'doc', title: '陌生<em>人</em>的库', summary: '应被默认范围过滤',
            url: '/stranger/other/doc-z', info: 'Stranger / Other', target: { id: 33, slug: 'doc-z' },
          },
        ],
      }, 200, rateHeaders())
    }
    throw new Error(`unhandled mock route: ${url.pathname}${url.search}`)
  }
  return { fetch: fetchImpl as typeof fetch, calls }
}

// ---------------------------------------------------------------------------
// In-memory kv backend for the storage hub (the only storage medium a unit
// test owns; the domain layer validates every record against the spec).
// ---------------------------------------------------------------------------

class MemoryKvUnit implements KvUnit {
  private readonly tables = new Map<string, Map<string, unknown>>()
  private globalValue: unknown = null

  constructor(private readonly descriptor: KvUnitDescriptor) {
    for (const table of descriptor.tables) this.tables.set(table, new Map())
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [name, records] of this.tables) tables[name] = Object.fromEntries(records)
    return { tables, global: this.globalValue }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    const records = this.tables.get(table)
    if (records === undefined) throw new Error(`unknown table ${table}`)
    records.set(key, value)
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.tables.get(table)?.delete(key)
  }

  async setGlobal(value: unknown): Promise<void> {
    if (!this.descriptor.hasGlobal) throw new Error('unit declares no global slot')
    this.globalValue = value
  }

  async close(): Promise<void> {}
}

const memoryBackend: StorageBackend = {
  kv: {
    open: (descriptor: KvUnitDescriptor) => Promise.resolve(new MemoryKvUnit(descriptor)),
  } satisfies KvFacet,
  close: () => Promise.resolve(),
}

// ---------------------------------------------------------------------------
// Harness: real services + the plugin on a fresh context.
// ---------------------------------------------------------------------------

/** The real fetch, captured before the Yuque mock takes over globalThis. */
const nativeFetch = globalThis.fetch

interface Harness {
  ctx: Context
  fiber: { dispose(): Promise<void> }
  port: number
  mock: ReturnType<typeof createYuqueMock>
  dispose(): Promise<void>
}

const dirs: string[] = []
const live: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const h of live.splice(0)) {
    await h.dispose()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function harness(config: Partial<Config> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-yuque-kb-composition-'))
  dirs.push(dir)
  const mock = createYuqueMock()
  vi.stubGlobal('fetch', mock.fetch)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', memoryBackend)
  // Real backend plugins provide the `storage.backend.<name>` lifecycle
  // service; the test backend provides it manually so the domain layer's
  // `ctx.inject` wait resolves.
  ctx.provide(storageBackendServiceKey('memory'), memoryBackend)
  await ctx.plugin(StorageDomain, { backend: 'memory' })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const fiber = await ctx.plugin(YuqueKb, {
    rateLimitPerSec: 1000, // keep throttle slots ~1ms for fast tests
    indexPath: join(dir, 'index.sqlite'),
    yuqueToken: 'test-token',
    ...config,
  })
  const h: Harness = {
    ctx,
    fiber,
    port: ctx.webServer.port,
    mock,
    dispose: async () => {
      await fiber.dispose()
    },
  }
  live.push(h)
  return h
}

let callSeq = 0

/** Execute one registered tool through the real registry pipeline. */
function runTool(ctx: Context, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId(`composition-${++callSeq}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

/** Join the model-visible text of a tool result. */
function textOf(result: ToolExecutionResult): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** The canonical value of a successful call. */
function valueOf<T = unknown>(result: ToolExecutionResult): T {
  if (result.isError) throw new Error(`tool failed: ${textOf(result)}`)
  return result.value as T
}

/** Poll until `predicate` holds (async settle races, e.g. startup sync). */
async function pollUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

async function getJson(h: Harness, path: string): Promise<{ status: number; body: unknown }> {
  const response = await nativeFetch(`http://127.0.0.1:${h.port}${path}`)
  return { status: response.status, body: await response.json() }
}

async function postJson(h: Harness, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await nativeFetch(`http://127.0.0.1:${h.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composition: boot, announcement, dispose', () => {
  it('registers the four tools and the announcement, then disposal removes them', async () => {
    const h = await harness()
    expect(h.ctx.tools.get('kb_sync')).toBeDefined()
    expect(h.ctx.tools.get('kb_search')).toBeDefined()
    expect(h.ctx.tools.get('kb_read')).toBeDefined()
    expect(h.ctx.tools.get('kb_search_remote')).toBeDefined()

    // Model-visible announcement (order-150 section); the section name is
    // a registry key — the rendered prompt carries the guidance text.
    const prompt = renderPrompt(await h.ctx.systemPrompt.assemble())
    expect(prompt).toContain('本机已安装 dsh-yuque-kb 插件')
    expect(prompt).toContain('kb_search_remote')
    expect(prompt).toContain('kb_sync')

    // Routes are live and fenced.
    const status = await getJson(h, '/api/dsh-yuque-kb/status')
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ syncing: false, tokenConfigured: true })

    // HMR safety: dispose the fiber, every registration vanishes.
    await h.fiber.dispose()
    expect(h.ctx.tools.get('kb_sync')).toBeUndefined()
    expect(h.ctx.tools.get('kb_search')).toBeUndefined()
    expect(h.ctx.tools.get('kb_read')).toBeUndefined()
    expect(h.ctx.tools.get('kb_search_remote')).toBeUndefined()
    const promptAfter = renderPrompt(await h.ctx.systemPrompt.assemble())
    expect(promptAfter).not.toContain('plugin:dsh-yuque-kb')
  })

  it('announceToAgent=false keeps the section out of the prompt', async () => {
    const h = await harness({ announceToAgent: false })
    const prompt = renderPrompt(await h.ctx.systemPrompt.assemble())
    expect(prompt).not.toContain('dsh-yuque-kb')
  })
})

describe('composition: kb_sync / kb_search / kb_read', () => {
  it('synces catalogues and bodies, then search finds and read pages them', async () => {
    const h = await harness()
    const syncResult = await runTool(h.ctx, 'kb_sync', {})
    expect(syncResult.isError).toBe(false)
    const value = valueOf<{
      kind: string
      synced: number
      added: number
      updated: number
      removed: number
      rateRemaining: number | null
      errors: unknown[]
    }>(syncResult)
    expect(value.kind).toBe('foreground')
    expect(value).toMatchObject({ synced: 2, added: 2, updated: 0, removed: 0, rateRemaining: 4900 })
    expect(value.errors).toEqual([])
    // Model-visible render.
    expect(textOf(syncResult)).toContain('synced 2 docs (added 2, updated 0, removed 0)')

    // kb_search: 3+ char token through FTS MATCH, snippet around the hit.
    const search = await runTool(h.ctx, 'kb_search', { query: 'alpha-beta', limit: 5 })
    const searchValue = valueOf<{
      total: number; truncated: boolean
      items: Array<{ docId: string; title: string; repo: string; snippet: string }>
    }>(search)
    expect(searchValue.total).toBe(1)
    expect(searchValue.items[0]).toMatchObject({ docId: '11', title: 'Doc A', repo: 'me/book1' })
    expect(searchValue.items[0]!.snippet).toContain('alpha-beta')
    const searchText = textOf(search)
    expect(searchText).toContain('1 hits')
    expect(searchText).toContain('[Doc A]')

    // kb_search: 2-char CJK term falls back to instr sub-string matching.
    const cjk = await runTool(h.ctx, 'kb_search', { query: '语雀' })
    const cjkValue = valueOf<{ total: number; items: Array<{ title: string }> }>(cjk)
    expect(cjkValue.total).toBe(2)
    expect(cjkValue.items.map(item => item.title).sort()).toEqual(['Doc A', 'Doc B'])

    // kb_read: local blocks with cursor paging.
    const read = await runTool(h.ctx, 'kb_read', { docId: '11', startBlock: 1, maxBlocks: 1 })
    const readValue = valueOf<{
      docId: string; title: string; repo: string; totalBlocks: number
      startBlock: number; nextCursor: number | null
      blocks: Array<{ type: string; text: string }>
    }>(read)
    expect(readValue).toMatchObject({
      docId: '11', title: 'Doc A', repo: 'me/book1', totalBlocks: 3, startBlock: 1, nextCursor: 2,
    })
    expect(readValue.blocks).toHaveLength(1)
    expect(readValue.blocks[0]!.type).toBe('paragraph')
    const readText = textOf(read)
    expect(readText).toContain('# Doc A')
    expect(readText).toContain('alpha-beta')

    const tail = await runTool(h.ctx, 'kb_read', { docId: '11', startBlock: 2 })
    const tailValue = valueOf<{ nextCursor: number | null; blocks: Array<{ type: string; text: string }> }>(tail)
    expect(tailValue.nextCursor).toBeNull()
    expect(tailValue.blocks[0]).toMatchObject({ type: 'code' })
    expect(tailValue.blocks[0]!.text).toContain('const alpha')
  })

  it('second sync is incremental (nothing changed ⇒ synced 0)', async () => {
    const h = await harness()
    await runTool(h.ctx, 'kb_sync', {})
    const again = await runTool(h.ctx, 'kb_sync', {})
    const value = valueOf<{ synced: number; added: number; updated: number; removed: number }>(again)
    expect(value).toMatchObject({ synced: 0, added: 0, updated: 0, removed: 0 })
  })

  it('enabled toggles exclude docs and repos from search and read (Q2)', async () => {
    const h = await harness()
    await runTool(h.ctx, 'kb_sync', {})

    // Doc-level disable.
    const toggle = await postJson(h, '/api/dsh-yuque-kb/toggle', { kind: 'doc', id: '11', enabled: false })
    expect(toggle.status).toBe(200)
    expect(toggle.body).toEqual({ ok: true })
    const afterDoc = valueOf<{ total: number; items: Array<{ title: string }> }>(
      await runTool(h.ctx, 'kb_search', { query: '语雀' }),
    )
    expect(afterDoc.items.map(item => item.title)).toEqual(['Doc B'])
    const blockedRead = await runTool(h.ctx, 'kb_read', { docId: '11' })
    expect(blockedRead.isError).toBe(true)
    expect(textOf(blockedRead)).toContain('disabled')

    // Repo-level disable excludes the whole library.
    await postJson(h, '/api/dsh-yuque-kb/toggle', { kind: 'doc', id: '11', enabled: true })
    await postJson(h, '/api/dsh-yuque-kb/toggle', { kind: 'repo', id: 'me/book1', enabled: false })
    const afterRepo = valueOf<{ total: number }>(await runTool(h.ctx, 'kb_search', { query: '语雀' }))
    expect(afterRepo.total).toBe(0)
  })

  it('kb_read falls back to a live fetch for a catalogue-only doc', async () => {
    const h = await harness()
    // Catalogue refresh only (no bodies indexed).
    const tree = await getJson(h, '/api/dsh-yuque-kb/tree?refresh=true')
    expect(tree.status).toBe(200)
    const read = await runTool(h.ctx, 'kb_read', { docId: '11', maxBlocks: 10 })
    expect(read.isError).toBe(false)
    const value = valueOf<{ totalBlocks: number; blocks: Array<{ type: string; text: string }> }>(read)
    expect(value.totalBlocks).toBe(3)
    expect(value.blocks[0]).toMatchObject({ type: 'heading', text: '# Doc A' })
  })

  it('kb_sync background without a jobs registry fails with an actionable error', async () => {
    const h = await harness()
    const result = await runTool(h.ctx, 'kb_sync', { run_in_background: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs')
  })
})

describe('composition: kb_search_remote', () => {
  it('strips <em> highlights and defaults the scope to the account repos', async () => {
    const h = await harness()
    await runTool(h.ctx, 'kb_sync', {})
    const result = await runTool(h.ctx, 'kb_search_remote', { query: '酒馆', limit: 10 })
    const value = valueOf<{ total: number; items: Array<{ docId: string; title: string; repo: string; url: string; summary: string }> }>(result)
    // The team/stranger-owned hits are filtered out by the default account scope.
    expect(value.items).toHaveLength(1)
    expect(value.items[0]).toMatchObject({
      docId: '31',
      title: '酒馆配置',
      repo: 'Me / Book One',
      url: 'https://www.yuque.com/me/book1/doc-x',
    })
    expect(value.items[0]!.summary).toContain('高亮')
    expect(value.items[0]!.summary).not.toContain('<em>')
    expect(textOf(result)).toContain('cloud search: 3 hits')
  })

  it('an explicit scope is passed through verbatim and disables the scope filter', async () => {
    const h = await harness()
    await runTool(h.ctx, 'kb_sync', {})
    const before = h.mock.calls.length
    const result = await runTool(h.ctx, 'kb_search_remote', { query: 'x', scope: 'me/book1' })
    const value = valueOf<{ items: unknown[] }>(result)
    expect(value.items).toHaveLength(3)
    const searchCall = h.mock.calls.find(call => call.pathname === '/api/v2/search')
    expect(searchCall?.query).toContain('scope=me%2Fbook1')
    expect(h.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('composition: /api routes', () => {
  it('token write (settings-less runtime credential), test, tree, toggle, status', async () => {
    const h = await harness({ yuqueToken: '' })
    // No settings service is mounted: the token lands in the domain global,
    // and tokenConfigured flips from false to true.
    const before = await getJson(h, '/api/dsh-yuque-kb/status')
    expect(before.body).toMatchObject({ tokenConfigured: false })

    const written = await postJson(h, '/api/dsh-yuque-kb/token', { token: 'runtime-secret' })
    expect(written.status).toBe(200)
    expect(written.body).toEqual({ ok: true })
    const after = await getJson(h, '/api/dsh-yuque-kb/status')
    expect(after.body).toMatchObject({ tokenConfigured: true })

    // Connection test with the stored token, then with a bad candidate.
    const good = await postJson(h, '/api/dsh-yuque-kb/test', {})
    expect(good.status).toBe(200)
    expect(good.body).toEqual({ ok: true, user: { login: 'me', name: 'Me', booksCount: 1 } })

    // Sync through the route (no jobs registry ⇒ inline foreground run).
    const synced = await postJson(h, '/api/dsh-yuque-kb/sync', {})
    expect(synced.status).toBe(200)
    expect(synced.body).toEqual({ ok: true })

    // Tree: personal repo with docs and sync state.
    const tree = await getJson(h, '/api/dsh-yuque-kb/tree')
    expect(tree.status).toBe(200)
    const treeBody = tree.body as {
      repos: Array<{ namespace: string; name: string; enabled: boolean; itemsCount: number; docs: Array<{ docId: string; synced: boolean; enabled: boolean }> }>
      lastSyncAt: number | null
    }
    expect(treeBody.lastSyncAt).toBeTypeOf('number')
    expect(treeBody.repos[0]).toMatchObject({
      namespace: 'me/book1', name: 'Book One', enabled: true, itemsCount: 2,
    })
    expect(treeBody.repos[0]!.docs).toHaveLength(2)
    expect(treeBody.repos[0]!.docs.every(doc => doc.synced)).toBe(true)

    // Toggle reflects in the tree immediately.
    await postJson(h, '/api/dsh-yuque-kb/toggle', { kind: 'doc', id: '12', enabled: false })
    const tree2 = await getJson(h, '/api/dsh-yuque-kb/tree')
    const tree2Body = tree2.body as { repos: Array<{ docs: Array<{ docId: string; enabled: boolean }> }> }
    expect(tree2Body.repos[0]!.docs.find(doc => doc.docId === '12')?.enabled).toBe(false)

    // Status carries the sync outcome + rate snapshot.
    const status = await getJson(h, '/api/dsh-yuque-kb/status')
    expect(status.body).toMatchObject({ syncing: false, rateRemaining: 4900, errors: [] })
  })

  it('catalogue placeholders show synced=false until a body sync', async () => {
    const h = await harness({ yuqueToken: '' })
    await postJson(h, '/api/dsh-yuque-kb/token', { token: 'runtime-secret' })
    // Refresh builds the catalogue without fetching bodies.
    const tree = await getJson(h, '/api/dsh-yuque-kb/tree?refresh=true')
    const body = tree.body as { repos: Array<{ docs: Array<{ docId: string; synced: boolean }> }>; lastSyncAt: number | null }
    expect(tree.status).toBe(200)
    expect(body.lastSyncAt).toBeNull()
    expect(body.repos[0]!.docs.every(doc => doc.synced === false)).toBe(true)
    // Keeping lastSyncAt null: refresh is not a sync.
    const status = await getJson(h, '/api/dsh-yuque-kb/status')
    expect(status.body).toMatchObject({ lastSyncAt: null })
  })

  it('rejects unknown endpoints and wrong methods', async () => {
    const h = await harness()
    const missing = await getJson(h, '/api/dsh-yuque-kb/nope')
    expect(missing.status).toBe(404)
    const wrongMethod = await getJson(h, '/api/dsh-yuque-kb/token')
    expect(wrongMethod.status).toBe(405)
  })
})

describe('composition: syncOnStartup', () => {
  it('runs an incremental sync at boot when enabled and a token exists', async () => {
    const h = await harness({ syncOnStartup: true })
    // The detached startup sync settles asynchronously: wait for lastSyncAt.
    await pollUntil(async () => {
      const status = await nativeFetch(`http://127.0.0.1:${h.port}/api/dsh-yuque-kb/status`)
      const body = await status.json() as { lastSyncAt: number | null }
      return body.lastSyncAt !== null
    })
    // And the search confirms the content is indexed.
    const search = await runTool(h.ctx, 'kb_search', { query: '知识库使用' })
    const value = valueOf<{ total: number; items: Array<{ title: string }> }>(search)
    expect(value.total).toBe(1)
    expect(value.items[0]!.title).toBe('Doc B')
  })
})