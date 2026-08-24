/**
 * Yuque adapter — the read-only facade over the OpenAPI v2 endpoints.
 *
 * Pure factory ({@link createYuqueClient}); no cordis imports here so the
 * adapter stays unit-testable with a mocked global fetch. All calls are GET
 * only — this plugin never writes to Yuque.
 */

import { createYuqueHttp, withRetry, YuqueApiError, type YuqueHttpResult } from './http.ts'
import type {
  RateLimit,
  YuqueDocDetail,
  YuqueDocSummary,
  YuqueLakeSheet,
  YuqueRepo,
  YuqueTocNode,
  YuqueUser,
} from './types.ts'

export { YuqueApiError } from './http.ts'
export type { YuqueErrorKind, YuqueHttp, YuqueHttpOptions, YuqueHttpResult } from './http.ts'

/** Factory options — the token is required, everything else has safe defaults. */
export interface YuqueClientOptions {
  token: string
  rateLimitPerSec?: number
  maxConcurrency?: number
  baseUrl?: string
  userAgent?: string
  /** Test seam: fetch implementation (default global fetch). */
  fetchImpl?: typeof fetch
  /** Test seam: async sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Test seam: clock. */
  now?: () => number
}

/** `GET /hello` payload. */
export interface HelloResult {
  message: string
}

/** Result of {@link YuqueClient.testConnection}. */
export interface TestConnectionResult {
  login: string
  name: string
  booksCount: number
  /** Rate-limit snapshot from the `/user` response (null when absent). */
  rateLimit: RateLimit | null
}

/** Full repo listing of the current user's personal repos. */
export interface ListReposResult {
  user: YuqueUser
  repos: YuqueRepo[]
}

/** Normalized markdown output of {@link YuqueClient.getDocMarkdown}. */
export interface DocMarkdown {
  markdown: string
  /** Source content format: `markdown` | `lakesheet` | `lake(minimal)` | … */
  format: string
}

/** The adapter surface exposed by {@link createYuqueClient}. */
export interface YuqueClient {
  /**
   * Validate a token via `/hello` + `/user`. When `candidateToken` is given
   * it is used for the probe and the original token is restored afterwards.
   */
  testConnection(candidateToken?: string): Promise<TestConnectionResult>
  /** Current user (`/user`). */
  getUser(): Promise<YuqueUser>
  /** Personal repos of the current user (`/users/{login}/repos`). */
  listUserRepos(): Promise<YuqueRepo[]>
  /** Current user + personal repos (`{ user, repos }`). */
  listRepos(): Promise<ListReposResult>
  /** Flat TOC tree of a repo (`/repos/{namespace}/toc`). */
  getToc(namespace: string): Promise<YuqueTocNode[]>
  /** Paged doc list of a repo (`/repos/{namespace}/docs`, limit=100). */
  listDocs(namespace: string): Promise<YuqueDocSummary[]>
  /** Full doc detail (all bodies present, no `?raw=1`). */
  getDoc(namespace: string, slug: string): Promise<YuqueDocDetail>
  /**
   * Doc markdown with format normalization (`?raw=1` first; lakesheet →
   * markdown table; lake JSON → minimal block conversion, refined in P4).
   */
  getDocMarkdown(namespace: string, slug: string): Promise<DocMarkdown>
}

/** Unwrap the `data` field of the standard Yuque envelope. */
function unwrap<T>(result: YuqueHttpResult): T {
  const body = result.body
  if (typeof body === 'object' && body !== null && 'data' in body) {
    return (body as { data: T }).data
  }
  return body as T
}

/** Read the docs-list `meta.total` when present. */
function readTotal(result: YuqueHttpResult): number | undefined {
  const body = result.body
  if (typeof body === 'object' && body !== null && 'meta' in body) {
    const total = (body as { meta?: { total?: unknown } }).meta?.total
    return typeof total === 'number' ? total : undefined
  }
  return undefined
}

/** Create a Yuque client bound to `options.token`. */
export function createYuqueClient(options: YuqueClientOptions): YuqueClient {
  const http = createYuqueHttp(options)

  async function testConnection(candidateToken?: string): Promise<TestConnectionResult> {
    const previous = options.token
    if (candidateToken !== undefined) {
      http.setToken(candidateToken)
    }
    try {
      // /hello validates the token; /user carries the account identity.
      await http.request<HelloResult>('/hello')
      const userResult = await http.request('/user')
      const user = unwrap<YuqueUser>(userResult)
      return {
        login: user.login,
        name: user.name,
        booksCount: user.books_count ?? 0,
        rateLimit: userResult.rateLimit,
      }
    } finally {
      if (candidateToken !== undefined) {
        http.setToken(previous)
      }
    }
  }

  async function getUser(): Promise<YuqueUser> {
    return unwrap<YuqueUser>(await http.request('/user'))
  }

  async function listUserRepos(): Promise<YuqueRepo[]> {
    const user = await getUser()
    return unwrap<YuqueRepo[]>(await http.request(`/users/${encodeURIComponent(user.login)}/repos`))
  }

  async function listRepos(): Promise<ListReposResult> {
    const user = await getUser()
    const repos = await listUserRepos()
    return { user, repos }
  }

  async function getToc(namespace: string): Promise<YuqueTocNode[]> {
    return unwrap<YuqueTocNode[]>(await http.request(`/repos/${namespace}/toc`))
  }

  async function listDocs(namespace: string): Promise<YuqueDocSummary[]> {
    const docs: YuqueDocSummary[] = []
    for (let offset = 0; ; offset += 100) {
      const result = await http.request(`/repos/${namespace}/docs?offset=${offset}&limit=100`)
      const batch = unwrap<YuqueDocSummary[]>(result)
      docs.push(...batch)
      const total = readTotal(result)
      if (total === undefined || docs.length >= total || batch.length === 0) break
    }
    return docs
  }

  async function getDoc(namespace: string, slug: string): Promise<YuqueDocDetail> {
    return unwrap<YuqueDocDetail>(
      await http.request(`/repos/${namespace}/docs/${encodeURIComponent(slug)}`),
    )
  }

  async function getDocMarkdown(namespace: string, slug: string): Promise<DocMarkdown> {
    const url = `/repos/${namespace}/docs/${encodeURIComponent(slug)}?raw=1`
    // Research: doc detail intermittently 404s — retry a couple of times.
    const result = await withRetry(() => http.request(url), {
      retries: 2,
      baseDelayMs: 150,
      maxDelayMs: 600,
      shouldRetry: (err) => err instanceof YuqueApiError && err.kind === 'not-found',
    })
    const detail = unwrap<YuqueDocDetail>(result)
    return normalizeDocBody(detail)
  }

  return {
    testConnection,
    getUser,
    listUserRepos,
    listRepos,
    getToc,
    listDocs,
    getDoc,
    getDocMarkdown,
  }
}

/**
 * Turn a doc detail into markdown:
 * 1. `?raw=1` already gives markdown for markdown/lake-format docs — use it.
 * 2. `lakesheet` → convert `body_sheet` JSON to a markdown table.
 * 3. lake JSON body (`{"ops":…`) → minimal block conversion (TODO P4: richer).
 */
export function normalizeDocBody(detail: YuqueDocDetail): DocMarkdown {
  const format = detail.format ?? 'markdown'
  const body = detail.body

  if (format === 'lakesheet' && detail.body_sheet) {
    return { markdown: lakeSheetToMarkdown(detail.body_sheet), format: 'lakesheet' }
  }
  if (typeof body === 'string' && body.trim().length > 0 && !looksLikeLakeJson(body)) {
    return { markdown: body, format }
  }
  // Lake editor JSON — minimal conversion (block-level only).
  const source = looksLikeLakeJson(body ?? '') ? (body as string) : detail.body_lake
  if (source && looksLikeLakeJson(source)) {
    return { markdown: minimalLakeToMarkdown(source), format: 'lake' }
  }
  // Last resort: raw body text (may be plain text or HTML for P4 to refine).
  return { markdown: typeof body === 'string' ? body : '', format }
}

function looksLikeLakeJson(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('{"ops":') || trimmed.startsWith('{"type":')
}

/** Convert a `body_sheet` JSON string into one markdown table per sheet. */
export function lakeSheetToMarkdown(bodySheet: string): string {
  let sheet: YuqueLakeSheet
  try {
    sheet = JSON.parse(bodySheet) as YuqueLakeSheet
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const table of sheet.data ?? []) {
    const rows = Array.isArray(table.table) ? table.table : []
    if (rows.length === 0) continue
    // Sheet row 0 is the header row.
    const [headerRow, ...bodyRows] = rows
    const width = Math.max(rows[0]?.length ?? 0, ...bodyRows.map((row) => row.length))
    const render = (row: unknown[]): string =>
      `| ${Array.from({ length: width }, (_, i) => escCell(cellText(row[i]))).join(' | ')} |`
    const lines: string[] = [render(headerRow ?? [])]
    lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
    for (const row of bodyRows) lines.push(render(row))
    parts.push(`### ${table.name}\n\n${lines.join('\n')}`)
  }
  return parts.join('\n\n')
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function escCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/**
 * Minimal lake-ops → markdown conversion (headings / paragraphs / code /
 * images / dividers). Sufficient for indexing; richer block fidelity and
 * `body_html` + turndown fallback land in P4.
 */
export function minimalLakeToMarkdown(lakeJson: string): string {
  let parsed: { ops?: unknown[] }
  try {
    parsed = JSON.parse(lakeJson) as { ops?: unknown[] }
  } catch {
    return ''
  }
  const ops = Array.isArray(parsed.ops) ? parsed.ops : []
  const lines: string[] = []

  for (const op of ops) {
    const attrs = (op as { attributes?: Record<string, unknown> }).attributes ?? {}
    const insert = (op as { insert?: unknown }).insert
    if (insert === null || insert === undefined) continue
    if (typeof insert === 'string') {
      if (insert === '\n') {
        lines.push('') // block separator
        continue
      }
      let text = insert
      if (typeof attrs.heading === 'number') {
        const level = Math.min(6, Math.max(1, attrs.heading))
        text = `${'#'.repeat(level)} ${text}`
      } else if (attrs.quote === true) {
        text = `> ${text}`
      }
      lines.push(trimTrailingNewline(text))
      continue
    }
    if (typeof insert === 'object') {
      const obj = insert as Record<string, unknown>
      if (typeof obj.code === 'string') {
        lines.push('```', obj.code, '```')
      } else if (typeof obj.formula === 'string') {
        lines.push(`$$${obj.formula}$$`)
      } else if (typeof obj.image === 'object' && obj.image !== null) {
        const src = (obj.image as Record<string, unknown>).src
        if (typeof src === 'string') lines.push(`![image](${src})`)
      } else if (typeof obj.html === 'string') {
        lines.push(obj.html)
      } else if (typeof obj.mention === 'string') {
        lines.push(`@${obj.mention}`)
      } else if (obj.divider === true) {
        lines.push('---')
      } else if (obj.d === true) {
        lines.push('---')
      } else {
        // Unknown embed (card/table…): keep as inline note.
        lines.push(`<!-- yuque embed: ${safeInline(JSON.stringify(obj))} -->`)
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function trimTrailingNewline(text: string): string {
  return text.replace(/\n+$/, '')
}

function safeInline(text: string): string {
  return text.replace(/-->/g, '-- >')
}