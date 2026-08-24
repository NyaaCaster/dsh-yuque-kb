/**
 * Adapter unit tests — deterministic via vi.stubGlobal('fetch', mock).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createYuqueClient,
  lakeSheetToMarkdown,
  minimalLakeToMarkdown,
  normalizeDocBody,
  type YuqueClientOptions,
} from '../../src/yuque/adapter.ts'
import type { YuqueDocDetail } from '../../src/yuque/types.ts'

/** Minimal route table: pathname → { status, body }. */
type Route = { status?: number; body: unknown }
type Routes = Map<string, Route | (() => Route)>

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function makeClient(routes: Routes, overrides: Partial<YuqueClientOptions> = {}) {
  const calls: Array<{ path: string; query: string; token?: string }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      path: url.pathname,
      query: url.search,
      token: new Headers(init?.headers).get('x-auth-token') ?? undefined,
    })
    const key = url.pathname.replace(/^\/api\/v2/, '')
    const entry = routes.get(key)
    if (!entry) throw new Error(`unhandled route ${key}`)
    const route = typeof entry === 'function' ? entry() : entry
    return jsonResponse(route.body, route.status ?? 200)
  })
  vi.stubGlobal('fetch', fetchImpl)
  const client = createYuqueClient({
    token: 't0',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    rateLimitPerSec: 1000, // keep unit tests fast
    maxConcurrency: 8,
    ...overrides,
  })
  return { client, fetchImpl, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const USER = {
  id: 64496860,
  login: 'nyaa-rgeis',
  name: 'Nyaa',
  books_count: 9,
  public_books_count: 5,
}

describe('testConnection', () => {
  it('validates via /hello and returns identity from /user', async () => {
    const { client, calls } = makeClient(
      new Map([
        ['/hello', { body: { data: { message: 'Hello Nyaa' } } }],
        [
          '/user',
          {
            body: { data: USER },
            status: 200,
          },
        ],
      ]),
    )
    const result = await client.testConnection()
    expect(result).toEqual({ login: 'nyaa-rgeis', name: 'Nyaa', booksCount: 9, rateLimit: null })
    expect(calls.map((c) => c.path)).toEqual(['/api/v2/hello', '/api/v2/user'])
  })

  it('uses a candidate token for the probe and restores the original after', async () => {
    const { client, calls } = makeClient(
      new Map([
        ['/hello', { body: { data: { message: 'hi' } } }],
        ['/user', { body: { data: USER } }],
      ]),
    )
    await client.testConnection('candidate-token')
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.token === 'candidate-token')).toBe(true)
    // Subsequent calls go back to the original token.
    await client.getUser()
    expect(calls[2]?.token).toBe('t0')
  })

  it('propagates token failures (401)', async () => {
    const { client } = makeClient(
      new Map([['/hello', { status: 401, body: { detail: 'Unauthorized' } }]]),
    )
    await expect(client.testConnection('bad')).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })
})

describe('listRepos', () => {
  it('combines personal repos with accessible team repos and skips 403 teams', async () => {
    const { client } = makeClient(
      new Map([
        ['/user', { body: { data: USER } }],
        [
          '/users/nyaa-rgeis/repos',
          {
            body: {
              data: [
                { id: 1, type: 'Book', slug: 'gupg1c', name: '个人库', namespace: 'nyaa-rgeis/gupg1c', items_count: 49, public: true },
              ],
            },
          },
        ],
        [
          '/users/64496860/groups',
          { body: { data: [{ id: 7, login: 'team-a', name: 'Team A' }] } },
        ],
        [
          '/groups/team-a/repos',
          {
            body: {
              data: [
                { id: 2, type: 'Book', slug: 'kb', name: '团队库', namespace: 'team-a/kb', items_count: 3, public: false },
              ],
            },
          },
        ],
      ]),
    )
    const result = await client.listRepos()
    expect(result.user.login).toBe('nyaa-rgeis')
    expect(result.repos).toHaveLength(1)
    expect(result.teams).toHaveLength(1)
    expect(result.teams[0]?.group.login).toBe('team-a')
    expect(result.teams[0]?.repos[0]?.namespace).toBe('team-a/kb')
    expect(result.skipped).toHaveLength(0)
  })

  it('reports 403 team repos as skipped instead of failing', async () => {
    const { client } = makeClient(
      new Map([
        ['/user', { body: { data: USER } }],
        ['/users/nyaa-rgeis/repos', { body: { data: [] } }],
        [
          '/users/64496860/groups',
          { body: { data: [{ id: 7, login: 'team-a', name: 'Team A' }] } },
        ],
        ['/groups/team-a/repos', { status: 403, body: { detail: '无权限' } }],
      ]),
    )
    const result = await client.listRepos()
    expect(result.teams).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ kind: 'forbidden', group: expect.objectContaining({ login: 'team-a' }) })
  })
})

describe('listDocs pagination', () => {
  it('pages with limit=100 until meta.total is covered', async () => {
    const { client, calls } = makeClient(
      new Map<string, Route | (() => Route)>([
        ['/user', { body: { data: USER } }],
        [
          '/repos/nyaa-rgeis/gupg1c/docs',
          () => ({
            body: {
              data: calls.some((c) => c.query.includes('offset=100'))
                ? [{ id: 4, slug: 'd4', title: 'D4' }, { id: 5, slug: 'd5', title: 'D5' }]
                : [{ id: 1, slug: 'd1', title: 'D1' }, { id: 2, slug: 'd2', title: 'D2' }, { id: 3, slug: 'd3', title: 'D3' }],
              meta: { total: 5 },
            },
          }),
        ],
      ]),
    )
    const docs = await client.listDocs('nyaa-rgeis/gupg1c')
    expect(docs).toHaveLength(5)
    expect(docs.map((d) => d.slug)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    const docCalls = calls.filter((c) => c.path === '/api/v2/repos/nyaa-rgeis/gupg1c/docs')
    expect(docCalls.map((c) => c.query)).toContain('?offset=0&limit=100')
    expect(docCalls.map((c) => c.query)).toContain('?offset=100&limit=100')
  })
})

describe('getDocMarkdown normalization', () => {
  const baseRoutes = (detail: YuqueDocDetail): Routes =>
    new Map([
      ['/repos/a/docs', { body: { data: [{ id: 1, slug: 'x', title: 'X' }], meta: { total: 1 } } }],
      ['/repos/a/docs/x', { body: { data: detail } }],
    ])

  it('returns raw=1 markdown body with the source format', async () => {
    const detail: YuqueDocDetail = { id: 1, book_id: 1, slug: 'x', title: 'X', format: 'lake', body: '# Hello\nmarkdown' }
    const { client } = makeClient(baseRoutes(detail))
    const result = await client.getDocMarkdown('a', 'x')
    expect(result).toEqual({ markdown: '# Hello\nmarkdown', format: 'lake' })
  })

  it('retries the intermittent 404 on doc detail and succeeds', async () => {
    let calls = 0
    const { client } = makeClient(
      new Map([
        ['/repos/a/docs/x', () => {
          calls++
          if (calls === 1) return { status: 404, body: { detail: 'Not Found' } }
          return { body: { data: { id: 1, book_id: 1, slug: 'x', title: 'X', format: 'markdown', body: '# Retried' } } }
        }],
      ]),
    )
    const result = await client.getDocMarkdown('a', 'x')
    expect(result.markdown).toBe('# Retried')
    expect(calls).toBe(2)
  })

  it('throws not-found after the retries are exhausted', async () => {
    const { client } = makeClient(
      new Map([['/repos/a/docs/x', { status: 404, body: { detail: 'Not Found' } }]]),
    )
    await expect(client.getDocMarkdown('a', 'x')).rejects.toMatchObject({ kind: 'not-found', status: 404 })
  })
})

describe('normalizeDocBody / lake conversions', () => {
  it('converts lakesheet body_sheet into markdown tables', () => {
    const bodySheet = JSON.stringify({
      version: 1,
      data: [
        {
          name: '配置表',
          index: 0,
          rowCount: 3,
          colCount: 2,
          table: [
            ['键', '值'],
            ['api_key', 'sk-abc'],
            ['speed|mode', 'fast'],
          ],
        },
      ],
    })
    const result = normalizeDocBody({ id: 1, book_id: 1, slug: 's', title: 'S', format: 'lakesheet', body: '', body_sheet: bodySheet })
    expect(result.format).toBe('lakesheet')
    expect(result.markdown).toContain('### 配置表')
    expect(result.markdown).toContain('| 键 | 值 |')
    expect(result.markdown).toContain('| --- | --- |')
    expect(result.markdown).toContain('| api_key | sk-abc |')
    // Pipe characters inside cells are escaped.
    expect(result.markdown).toContain('| speed\\|mode | fast |')
  })

  it('converts lake JSON bodies with minimal block conversion', () => {
    const lake = JSON.stringify({
      ops: [
        { insert: 'Title', attributes: { heading: 1 } },
        { insert: '\n' },
        { insert: 'plain paragraph' },
        { insert: '\n' },
        { insert: { code: 'const a = 1' } },
        { insert: '\n' },
        { insert: { image: { src: 'https://cdn.example/x.png' } } },
        { insert: '\n' },
      ],
    })
    const result = normalizeDocBody({ id: 1, book_id: 1, slug: 's', title: 'S', format: 'lake', body: lake, body_lake: lake })
    expect(result.format).toBe('lake')
    expect(result.markdown).toContain('# Title')
    expect(result.markdown).toContain('plain paragraph')
    expect(result.markdown).toContain('```\nconst a = 1\n```')
    expect(result.markdown).toContain('![image](https://cdn.example/x.png)')
  })

  it('falls back to body_lake when body is lake JSON and body missing', () => {
    const lake = JSON.stringify({ ops: [{ insert: 'from lake' }, { insert: '\n' }] })
    const result = normalizeDocBody({ id: 1, book_id: 1, slug: 's', title: 'S', format: 'lake', body: null, body_lake: lake })
    expect(result.format).toBe('lake')
    expect(result.markdown).toContain('from lake')
  })

  it('returns empty markdown when nothing convertible exists', () => {
    const result = normalizeDocBody({ id: 1, book_id: 1, slug: 's', title: 'S', format: 'lakesheet', body: '' })
    expect(result.markdown).toBe('')
  })

  it('lakeSheetToMarkdown returns empty for broken JSON', () => {
    expect(lakeSheetToMarkdown('{oops')).toBe('')
  })

  it('minimalLakeToMarkdown returns empty for broken JSON', () => {
    expect(minimalLakeToMarkdown('not json')).toBe('')
  })
})