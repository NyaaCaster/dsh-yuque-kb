/**
 * KbEngine — the yuque-kb host capability. Ties the P2 Yuque adapter
 * (`src/yuque/`) to the P3 local store (`src/storage/`): incremental sync
 * pulls repo/doc catalogs and doc bodies into the FTS5 index plus the
 * storage domain, and the search/read/remote-search/status operations serve
 * both the `kb_*` tools and the `/api/dsh-yuque-kb` routes. Everything is
 * injectable (fetch/sleep/clock) so unit tests and the composition test run
 * against mocked Yuque HTTP.
 *
 * Token precedence: the settings namespace / composition `yuqueToken`
 * (checked first), then the runtime credential stored in the domain global
 * (`POST /api/dsh-yuque-kb/token` when no settings service is mounted).
 */

import { chunkMarkdown } from './storage/chunk.ts'
import type { DocRecord, DocId, KbDomain, RepoId, RepoRecord } from './storage/domain.ts'
import { getDoc, getGlobal, getRepo, setDoc, setEnabled, setGlobal, setRepo } from './storage/domain.ts'
import type { KbIndex, KbSearchResult } from './storage/fts.ts'
import type { RateLimit, YuqueDocSummary, YuqueTocNode } from './yuque/types.ts'
import type { YuqueClient } from './yuque/adapter.ts'
import { createYuqueClient, YuqueApiError } from './yuque/adapter.ts'
import type { YuqueHttp } from './yuque/http.ts'
import { createYuqueHttp } from './yuque/http.ts'
import { diffDocs } from './yuque/diff.ts'

/** The Config slice this engine reads (the plugin Config is assignable). */
export interface KbEngineConfig {
  yuqueToken?: string
  rateLimitPerSec?: number
  searchLimit?: number
  blockCharLimit?: number
  timeoutMs?: number
}

/** Options for {@link createEngine}. */
export interface KbEngineOptions {
  /** Opened `yuque_kb` storage domain (owned by the caller's effect). */
  domain: KbDomain
  /** Opened FTS5 index (owned by the caller's effect). */
  index: KbIndex
  /** Live config thunk (settings section or composition entry). */
  config: () => KbEngineConfig
  /** Test seam: fetch implementation (default global fetch). */
  fetchImpl?: typeof fetch
  /** Test seam: async sleep (default setTimeout). */
  sleep?: (ms: number) => Promise<void>
  /** Test seam: clock (default Date.now). */
  now?: () => number
}

/** One progress tick of a running sync. */
export interface SyncProgress {
  /** The repo being processed (namespace). */
  repo: string
  /** `toc` / `docs` / `body` — which stage is in flight. */
  phase: 'toc' | 'docs' | 'body'
  /** Docs fully processed in the `body` stage. */
  done: number
  /** Docs to fetch in the `body` stage. */
  total: number
}

/** One non-fatal sync failure (partial progress continues). */
export interface SyncError {
  /** The repo namespace, when known. */
  repo?: string
  /** The doc slug, for body-stage failures. */
  doc?: string
  /** Human-readable failure reason. */
  message: string
}

/** Foreground sync outcome (the `kb_sync` foreground contract). */
export interface SyncResult {
  /** Docs whose body was re-indexed. */
  synced: number
  /** Docs new on the remote side. */
  added: number
  /** Docs changed since the last sync. */
  updated: number
  /** Docs gone remotely, removed locally. */
  removed: number
  /** Non-fatal failures (per repo / per doc). */
  errors: SyncError[]
  /** Last observed X-RateLimit-Remaining; null when unknown. */
  rateRemaining: number | null
}

/** `GET /api/dsh-yuque-kb/tree` catalogue (SSOT §3.2 + P4 contract update). */
export interface TreePayload {
  /** Personal repos of the token account. */
  repos: TreeRepo[]
  lastSyncAt: number | null
  rateRemaining: number | null
}

/** One repo node of the tree. */
export interface TreeRepo {
  namespace: string
  name: string
  type: string
  enabled: boolean
  updatedAt: number
  itemsCount: number
  /** Local doc list (`synced` = body is in the FTS index). */
  docs: TreeDoc[]
}

/** One doc node of the tree. */
export interface TreeDoc {
  docId: string
  slug: string
  title: string
  path: string
  enabled: boolean
  updatedAt: number
  /** `true` when the body is indexed (record has a non-empty format). */
  synced: boolean
}

/** `GET /api/dsh-yuque-kb/status` payload. */
export interface StatusPayload {
  syncing: boolean
  progress?: SyncProgress
  lastSyncAt: number | null
  rateRemaining: number | null
  /** Errors of the most recent sync (retained until the next one). */
  errors: SyncError[]
  tokenConfigured: boolean
}

/** One block of a `kb_read` result. */
export interface ReadBlock {
  type: string
  text: string
}

/** `kb_read` result — local index blocks or a live fetch fallback. */
export interface ReadResult {
  docId: string
  title: string
  repo: string
  totalBlocks: number
  startBlock: number
  /** Next `startBlock` to continue, or `null` at the end. */
  nextCursor: number | null
  blocks: ReadBlock[]
}

/** `kb_search_remote` options (scope is passed through verbatim when set). */
export interface RemoteSearchOptions {
  query: string
  scope?: string
  limit?: number
  strict?: boolean
}

/** One `kb_search_remote` hit. */
export interface RemoteSearchItem {
  docId: string
  title: string
  repo: string
  url: string
  summary: string
}

/** `kb_search_remote` result. */
export interface RemoteSearchResult {
  total: number
  items: RemoteSearchItem[]
}

/** Sync options of {@link KbEngine.sync}. */
export interface SyncOptions {
  /** Restrict to these repo namespaces (default: every accessible repo). */
  repos?: string[]
  /** Forwarded into the client's fetch (AbortSignal.any). */
  signal?: AbortSignal
}

/** Batch width for doc-body fetches inside one repo. */
const BODY_BATCH = 4

/** Parse a Yuque ISO timestamp to epoch ms; 0 when unparsable. */
function parseEpoch(value: string | undefined): number {
  if (value === undefined) return 0
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? 0 : ms
}

/** Strip `<em>` (and other inline tags) from a Yuque search snippet. */
export function stripHtmlTags(text: string): string {
  return text
    .replace(/<\/?em>/giu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Build breadcrumb paths from a flat TOC: each DOC node gets its TITLE
 * ancestors joined by " / " (no TITLE ancestors → empty path).
 */
export function buildDocPaths(toc: readonly YuqueTocNode[]): Map<string, string> {
  const byUuid = new Map(toc.map(node => [node.uuid, node]))
  const paths = new Map<string, string>()
  for (const node of toc) {
    if (node.type !== 'DOC' || node.slug === undefined) continue
    const crumbs: string[] = []
    let cursor = node
    let depth = 0
    while (cursor.parent_uuid !== undefined && depth < 64) {
      const parent = byUuid.get(cursor.parent_uuid)
      if (parent === undefined) break
      if (parent.type === 'TITLE' && parent.title !== '') crumbs.push(parent.title)
      cursor = parent
      depth += 1
    }
    paths.set(node.slug, crumbs.reverse().join(' / '))
  }
  return paths
}

/** The engine surface shared by tools and routes. */
export interface KbEngine {
  /** Resolve the effective token (config first, then domain global). */
  resolveToken(): string | undefined
  /** Persist a runtime token into the domain global (settings-less path). */
  saveRuntimeToken(token: string): Promise<void>
  /** Probe the connection with the current (or a candidate) token. */
  testConnection(candidateToken?: string): Promise<
    { ok: true; user: { login: string; name: string; booksCount: number } }
    | { ok: false; error: string }
  >
  /** Refresh the local repo/doc catalogue (no body fetching). */
  refreshCatalog(signal?: AbortSignal): Promise<void>
  /** Incremental sync (catalogue + changed bodies). */
  sync(options?: SyncOptions): Promise<SyncResult>
  /** Read the cached tree directly from the domain. */
  tree(): TreePayload
  /** Flip the enabled switch of one repo or doc. */
  toggle(kind: 'repo' | 'doc', id: string, enabled: boolean): Promise<boolean>
  /** Route-facing status snapshot. */
  status(): StatusPayload
  /** Local FTS search over enabled docs. */
  search(query: string, limit?: number, repo?: string): KbSearchResult
  /** Block-paged body read; falls back to a live fetch when not indexed. */
  read(docId: string, startBlock?: number, maxBlocks?: number, signal?: AbortSignal): Promise<ReadResult>
  /** Yuque cloud search (strip `<em>`, default scope = the account's repos). */
  searchRemote(options: RemoteSearchOptions, signal?: AbortSignal): Promise<RemoteSearchResult>
  /** Last known rate-limit snapshot (from the response tap), else domain. */
  rateRemaining(): number | null
}

/** Create the engine over an opened domain + index. */
export function createEngine(engineOptions: KbEngineOptions): KbEngine {
  const domain = engineOptions.domain
  const index = engineOptions.index
  const fetchImpl = engineOptions.fetchImpl ?? globalThis.fetch
  const sleep = engineOptions.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const now = engineOptions.now ?? Date.now

  let lastRateSnapshot: RateLimit | null = null
  let lastErrors: SyncError[] = []
  let syncState: { running: boolean; progress?: SyncProgress } = { running: false }

  function resolveToken(): string | undefined {
    const configured = engineOptions.config().yuqueToken
    if (configured !== undefined && configured.trim() !== '') return configured
    const stored = getGlobal(domain).runtimeToken
    if (stored !== undefined && stored !== null && stored.trim() !== '') return stored
    return undefined
  }

  async function saveRuntimeToken(token: string): Promise<void> {
    const global = getGlobal(domain)
    await setGlobal(domain, { ...global, runtimeToken: token.trim() === '' ? null : token })
  }

  /** Capture rate-limit headers on every response (adapter drops them). */
  function captureRateLimit(response: Response): void {
    const limitRaw = response.headers.get('x-ratelimit-limit')
    const remainingRaw = response.headers.get('x-ratelimit-remaining')
    if (limitRaw === null || remainingRaw === null) return
    const limit = Number(limitRaw)
    const remaining = Number(remainingRaw)
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return
    lastRateSnapshot = { limit, remaining }
  }

  function makeClient(signal?: AbortSignal): YuqueClient {
    const token = resolveToken()
    if (token === undefined) {
      throw new Error(
        'yuque token is not configured: set it in the 知识库 settings page or POST /api/dsh-yuque-kb/token',
      )
    }
    return createYuqueClient({
      token,
      rateLimitPerSec: engineOptions.config().rateLimitPerSec,
      fetchImpl: makeFetch(signal),
      sleep,
      now,
    })
  }

  /** One throttled raw request (search etc.) sharing the same transport. */
  function makeHttp(signal?: AbortSignal): YuqueHttp {
    const token = resolveToken()
    if (token === undefined) {
      throw new Error(
        'yuque token is not configured: set it in the 知识库 settings page or POST /api/dsh-yuque-kb/token',
      )
    }
    return createYuqueHttp({
      token,
      rateLimitPerSec: engineOptions.config().rateLimitPerSec,
      fetchImpl: makeFetch(signal),
      sleep,
      now,
    })
  }

  /** Wrap the base fetch: fuse the forwarded signal + capture rate headers. */
  function makeFetch(signal?: AbortSignal): typeof fetch {
    return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      let effective: RequestInit | undefined = init
      const signals = [signal, init?.signal].filter((entry): entry is AbortSignal => entry !== undefined)
      if (signals.length > 0) {
        effective = { ...init, signal: AbortSignal.any(signals) }
      }
      return fetchImpl(input, effective).then(response => {
        captureRateLimit(response)
        return response
      })
    }
  }

  function rateRemaining(): number | null {
    if (lastRateSnapshot !== null) return lastRateSnapshot.remaining
    return getGlobal(domain).rateRemaining
  }

  async function testConnection(
    candidateToken?: string,
  ): Promise<
    { ok: true; user: { login: string; name: string; booksCount: number } }
    | { ok: false; error: string }
  > {
    if (candidateToken === undefined && resolveToken() === undefined) {
      return { ok: false, error: 'yuque token is not configured' }
    }
    try {
      const client = makeClient()
      const result = await client.testConnection(candidateToken)
      return { ok: true, user: { login: result.login, name: result.name, booksCount: result.booksCount } }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  /** Rebuild the local catalogue (repos + toc + doc lists) without bodies. */
  async function refreshCatalog(signal?: AbortSignal): Promise<void> {
    const client = makeClient(signal)
    const { repos } = await client.listRepos()
    const allRepos = repos
    const failures: string[] = []
    for (const repo of allRepos) {
      try {
        const [toc, docs] = await Promise.all([
          client.getToc(repo.namespace),
          client.listDocs(repo.namespace),
        ])
        const paths = buildDocPaths(toc)
        for (const summary of docs) {
          const docId = String(summary.id)
          const previous = getDoc(domain, docId as DocId)
          const updatedAt = parseEpoch(summary.content_updated_at ?? summary.updated_at)
          if (previous === undefined) {
            // Catalogue-only placeholder: body not indexed yet (synced=false).
            await setDoc(domain, docId as DocId, {
              repoId: repo.namespace as RepoId,
              slug: summary.slug,
              title: summary.title,
              path: paths.get(summary.slug) ?? '',
              enabled: true,
              updatedAt,
              wordCount: 0,
              blocks: 0,
              format: '',
            })
          } else {
            // Keep the sync state; refresh name/path/timestamps only.
            await setDoc(domain, docId as DocId, {
              ...previous,
              slug: summary.slug,
              title: summary.title,
              path: paths.get(summary.slug) ?? previous.path,
              updatedAt,
            })
          }
        }
        await setRepo(domain, repo.namespace as RepoId, {
          namespace: repo.namespace,
          name: repo.name,
          type: repo.type,
          enabled: getRepo(domain, repo.namespace as RepoId)?.enabled ?? true,
          team: null,
          updatedAt: now(),
          itemsCount: docs.length,
        })
      } catch (error) {
        failures.push(`${repo.namespace}: ${describeError(error)}`)
      }
    }
    if (failures.length === allRepos.length && failures.length > 0) {
      throw new Error(`catalogue refresh failed: ${failures.join('; ')}`)
    }
    const global = getGlobal(domain)
    await setGlobal(domain, { ...global, rateRemaining: rateRemaining() })
  }

  /** Incremental sync: catalogue + changed bodies (see module docs). */
  async function sync(options?: SyncOptions): Promise<SyncResult> {
    const signal = options?.signal
    const reposFilter = options?.repos
    if (syncState.running) {
      throw new Error('a sync is already running for this plugin instance')
    }
    syncState = { running: true, progress: undefined }
    lastErrors = []
    const errors: SyncError[] = []
    const counts = { synced: 0, added: 0, updated: 0, removed: 0 }
    try {
      const client = makeClient(signal)
      const { repos: repoList } = await client.listRepos()
      const targeted = reposFilter === undefined || reposFilter.length === 0
        ? repoList
        : repoList.filter(repo => reposFilter.includes(repo.namespace))
      if (targeted.length === 0 && reposFilter !== undefined && reposFilter.length > 0) {
        throw new Error(`no accessible repo matches ${reposFilter.join(', ')}`)
      }

      for (const repo of targeted) {
        const namespace = repo.namespace
        let paths = new Map<string, string>()
        syncState = { running: true, progress: { repo: namespace, phase: 'toc', done: 0, total: 0 } }
        try {
          paths = buildDocPaths(await client.getToc(namespace))
        } catch (error) {
          errors.push({ repo: namespace, message: `toc: ${describeError(error)}` })
        }

        let remoteDocs: YuqueDocSummary[]
        syncState = { ...syncState, progress: { repo: namespace, phase: 'docs', done: 0, total: 0 } }
        try {
          remoteDocs = await client.listDocs(namespace)
        } catch (error) {
          errors.push({ repo: namespace, message: `docs: ${describeError(error)}` })
          continue
        }

        // Diff against the local docs of this repo.
        const localRefs = [...domain.table('docs').entries()]
          .filter(([, record]) => record.repoId === namespace)
          .map(([docId, record]) => ({
            slug: record.slug,
            updatedAt: record.updatedAt > 0 ? new Date(record.updatedAt).toISOString() : undefined,
            docId: String(docId),
          }))
        const remoteRefs = remoteDocs.map(doc => ({ slug: doc.slug, updatedAt: doc.content_updated_at ?? doc.updated_at }))
        const { added, updated, removed } = diffDocs(localRefs, remoteRefs)
        counts.added += added.length
        counts.updated += updated.length
        counts.removed += removed.length

        // Remove gone docs (domain + index in lockstep).
        for (const ref of removed) {
          const local = localRefs.find(candidate => candidate.slug === ref.slug)
          if (local === undefined) continue
          index.removeDocs([local.docId])
          await domain.table('docs').delete(local.docId as DocId)
        }

        // Body stage: fetch changed docs in bounded batches.
        const changed = [...added, ...updated]
        syncState = {
          running: true,
          progress: { repo: namespace, phase: 'body', done: 0, total: changed.length },
        }
        for (let offset = 0; offset < changed.length; offset += BODY_BATCH) {
          const batch = changed.slice(offset, offset + BODY_BATCH)
          await Promise.all(batch.map(async (ref) => {
            const local = localRefs.find(candidate => candidate.slug === ref.slug)
            try {
              const { markdown, format } = await client.getDocMarkdown(namespace, ref.slug)
              const chunks = chunkMarkdown(markdown, { maxChars: engineOptions.config().blockCharLimit })
              const docId = local?.docId ?? String(remoteDocId(remoteDocs, ref.slug))
              const updatedAt = parseEpoch(ref.updatedAt)
              index.upsertDocs([{
                docId: String(docId),
                title: remoteDocTitle(remoteDocs, ref.slug),
                path: paths.get(ref.slug) ?? '',
                repo: namespace,
                updatedAt,
                body: markdown,
              }])
              const previous = getDoc(domain, docId as DocId)
              await setDoc(domain, docId as DocId, {
                repoId: namespace as RepoId,
                slug: ref.slug,
                title: remoteDocTitle(remoteDocs, ref.slug),
                path: paths.get(ref.slug) ?? previous?.path ?? '',
                enabled: previous?.enabled ?? true,
                updatedAt,
                wordCount: estimateWordCount(markdown),
                blocks: chunks.length,
                format: format !== '' ? format : 'markdown',
              })
              counts.synced += 1
            } catch (error) {
              // Added-but-failed docs stay as catalogue placeholders so the
              // tree can show them as not synced; updated failures keep their
              // previous record (the old body stays searchable).
              errors.push({ repo: namespace, doc: ref.slug, message: describeError(error) })
              if (local === undefined) {
                const docId = String(remoteDocId(remoteDocs, ref.slug))
                if (getDoc(domain, docId as DocId) === undefined) {
                  await setDoc(domain, docId as DocId, {
                    repoId: namespace as RepoId,
                    slug: ref.slug,
                    title: remoteDocTitle(remoteDocs, ref.slug),
                    path: paths.get(ref.slug) ?? '',
                    enabled: true,
                    updatedAt: parseEpoch(ref.updatedAt),
                    wordCount: 0,
                    blocks: 0,
                    format: '',
                  })
                }
              }
            } finally {
              const progress = syncState.progress
              if (progress !== undefined) {
                syncState = { running: true, progress: { ...progress, done: progress.done + 1 } }
              }
            }
          }))
        }

        const previousRepo = getRepo(domain, namespace as RepoId)
        await setRepo(domain, namespace as RepoId, {
          namespace,
          name: repo.name,
          type: repo.type,
          enabled: previousRepo?.enabled ?? true,
          team: null,
          updatedAt: now(),
          itemsCount: remoteDocs.length,
        })
      }

      const global = getGlobal(domain)
      await setGlobal(domain, { ...global, lastSyncAt: now(), rateRemaining: rateRemaining() })
      lastErrors = errors
      return { ...counts, errors, rateRemaining: rateRemaining() }
    } finally {
      syncState = { running: false }
    }
  }

  function tree(): TreePayload {
    const global = getGlobal(domain)
    const repos = [...domain.table('repos').entries()]
      .map(([, record]) => record)
      .sort((left, right) => left.namespace.localeCompare(right.namespace))
    const docsById = new Map<string, DocRecord>()
    for (const [docId, record] of domain.table('docs').entries()) {
      docsById.set(String(docId), record)
    }
    const repoNode = (record: RepoRecord): TreeRepo => {
      const docs: TreeDoc[] = []
      for (const [docId, doc] of docsById) {
        if (doc.repoId !== record.namespace) continue
        docs.push({
          docId: String(docId),
          slug: doc.slug,
          title: doc.title,
          path: doc.path,
          enabled: doc.enabled,
          updatedAt: doc.updatedAt,
          // Convention: a non-empty format marks an indexed body.
          synced: doc.format !== '',
        })
      }
      docs.sort((left, right) => left.title.localeCompare(right.title))
      return {
        namespace: record.namespace,
        name: record.name,
        type: record.type,
        enabled: record.enabled,
        updatedAt: record.updatedAt,
        itemsCount: record.itemsCount,
        docs,
      }
    }
    return {
      repos: repos.map(repoNode),
      lastSyncAt: global.lastSyncAt,
      rateRemaining: global.rateRemaining,
    }
  }

  async function toggle(kind: 'repo' | 'doc', id: string, enabled: boolean): Promise<boolean> {
    return setEnabled(domain, kind, id, enabled)
  }

  function status(): StatusPayload {
    const global = getGlobal(domain)
    return {
      syncing: syncState.running,
      ...syncState.progress !== undefined ? { progress: syncState.progress } : {},
      lastSyncAt: global.lastSyncAt,
      rateRemaining: rateRemaining(),
      errors: lastErrors,
      tokenConfigured: resolveToken() !== undefined,
    }
  }

  function search(query: string, limit?: number, repo?: string) {
    const enabledIds = new Set<string>()
    for (const [docId, record] of domain.table('docs').entries()) {
      if (!record.enabled) continue
      // Q2: a disabled repo excludes its docs regardless of the doc flag.
      const owner = getRepo(domain, record.repoId)
      if (owner !== undefined && !owner.enabled) continue
      enabledIds.add(String(docId))
    }
    const effectiveLimit = limit ?? engineOptions.config().searchLimit
    return index.search({ query, limit: effectiveLimit, repo, enabledIds })
  }

  async function read(
    docId: string,
    startBlock = 0,
    maxBlocks = 20,
    signal?: AbortSignal,
  ): Promise<ReadResult> {
    const record = getDoc(domain, docId as DocId)
    if (record === undefined) {
      throw new Error(`doc ${docId} is not in the local catalogue (run kb_sync first)`)
    }
    const repo = getRepo(domain, record.repoId)
    // Q2: disabled docs/repos are excluded from kb_read as well.
    if (!record.enabled || (repo !== undefined && !repo.enabled)) {
      throw new Error(`doc ${docId} is disabled (enable it in the 知识库 tree to read)`)
    }
    let blocks = index.readDocBlocks(String(docId))
    if (blocks.length === 0) {
      // Not indexed (catalogue placeholder): fetch the body live, temporarily.
      if (repo === undefined) {
        throw new Error(`doc ${docId}: owning repo ${record.repoId} is missing from the local store`)
      }
      const client = makeClient(signal)
      const { markdown } = await client.getDocMarkdown(repo.namespace, record.slug)
      blocks = chunkMarkdown(markdown, { maxChars: engineOptions.config().blockCharLimit })
        .map(chunk => ({ type: chunk.type, text: chunk.text }))
    }
    const total = blocks.length
    const from = Math.max(0, Math.floor(startBlock))
    const size = Math.min(Math.max(1, Math.floor(maxBlocks)), 50)
    const page = blocks.slice(from, from + size)
    const nextCursor = from + page.length < total ? from + page.length : null
    return {
      docId,
      title: record.title,
      repo: record.repoId,
      totalBlocks: total,
      startBlock: from,
      nextCursor,
      blocks: page,
    }
  }

  async function searchRemote(
    request: RemoteSearchOptions,
    signal?: AbortSignal,
  ): Promise<RemoteSearchResult> {
    if (request.query.trim() === '') {
      return { total: 0, items: [] }
    }
    const http = makeHttp(signal)
    const params = new URLSearchParams({ q: request.query, type: 'doc', page: '1' })
    if (request.scope !== undefined && request.scope !== '') params.set('scope', request.scope)
    if (request.strict === true) params.set('strict', 'true')
    const userEnvelope = (await http.request('/user')).body as { data?: { login?: unknown } }
    const login = typeof userEnvelope.data?.login === 'string' ? userEnvelope.data.login : ''
    const result = await http.request(`/search?${params.toString()}`)
    const body = result.body as { meta?: { total?: unknown }; data?: unknown }
    const total = typeof body.meta?.total === 'number' ? body.meta.total : 0
    const data = Array.isArray(body.data) ? body.data : []
    // Default scope = this account's personal repos: a
    // client-side filter over the result URLs (V0.1 approximation, see README).
    const allow = new Set<string>()
    for (const repo of domain.table('repos').keys()) {
      const [login] = String(repo).split('/')
      if (login !== undefined) allow.add(login)
    }
    allow.add(login)
    const scopeFiltered = request.scope !== undefined && request.scope !== ''
      ? data
      : data.filter(entry => {
          const url = typeof (entry as { url?: unknown }).url === 'string' ? (entry as { url: string }).url : ''
          const match = /^\/([^/]+)\//u.exec(url)
          if (match?.[1] === undefined) return true // cannot attribute: keep
          return allow.has(match[1])
        })
    const limit = Math.min(Math.max(1, Math.floor(request.limit ?? 10)), 20)
    const items = scopeFiltered.slice(0, limit).map(entry => {
      const record = entry as {
        id?: unknown
        title?: unknown
        summary?: unknown
        url?: unknown
        info?: unknown
        target?: { id?: unknown }
      }
      const url = typeof record.url === 'string' ? record.url : ''
      return {
        docId: String(record.target?.id ?? record.id ?? ''),
        title: stripHtmlTags(typeof record.title === 'string' ? record.title : ''),
        repo: typeof record.info === 'string' ? stripHtmlTags(record.info) : '',
        url: url.startsWith('http') ? url : `https://www.yuque.com${url}`,
        summary: stripHtmlTags(typeof record.summary === 'string' ? record.summary : ''),
      }
    })
    return { total, items }
  }

  return {
    resolveToken,
    saveRuntimeToken,
    testConnection,
    refreshCatalog,
    sync,
    tree,
    toggle,
    status,
    search,
    read,
    searchRemote,
    rateRemaining,
  }
}

/** Readable error text for any thrown value. */
function describeError(error: unknown): string {
  if (error instanceof YuqueApiError) {
    return `${error.kind}: ${error.message}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/** Resolve the numeric doc id of one remote ref (for catalogue placeholders). */
function remoteDocId(docs: readonly YuqueDocSummary[], slug: string): number {
  return docs.find(doc => doc.slug === slug)?.id ?? 0
}

/** Resolve the doc title of one remote ref. */
function remoteDocTitle(docs: readonly YuqueDocSummary[], slug: string): string {
  return docs.find(doc => doc.slug === slug)?.title ?? slug
}

/** Rough CJK-aware word count (CJK chars + whitespace-separated words). */
function estimateWordCount(markdown: string): number {
  const cjk = markdown.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/gu)?.length ?? 0
  const latin = markdown.replace(/[\u4E00-\u9FFF\u3400-\u4DBF]/gu, ' ').trim().split(/\s+/u)
    .filter(token => token !== '').length
  return cjk + latin
}