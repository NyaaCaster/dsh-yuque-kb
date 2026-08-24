/**
 * Yuque OpenAPI v2 HTTP transport.
 *
 * Responsibilities:
 * - Auth header (`X-Auth-Token`) + mandatory `User-Agent`.
 * - Follow redirects, parse JSON, surface `X-RateLimit-*` headers.
 * - Client-side throttling (default 3 req/s) + bounded concurrency (default 2).
 * - 429 exponential backoff honoring `Retry-After`; error classification into
 *   a structured {@link YuqueApiError}.
 * - `withRetry` helper for the documented intermittent detail 404s.
 *
 * Uses the global fetch (Node >= 22); everything is injectable for tests.
 */

import type { RateLimit } from './types.ts'

export const YUQUE_BASE_URL = 'https://www.yuque.com/api/v2'
export const DEFAULT_USER_AGENT = 'dsh-yuque-kb/0.1'

/** Machine-readable error categories for the adapter / routes. */
export type YuqueErrorKind =
  | 'auth' // 401 — token missing/invalid
  | 'forbidden' // 403 — no permission on resource
  | 'not-found' // 404 — entity missing (or intermittent Yuque glitch)
  | 'rate-limited' // 429 — quota exhausted
  | 'invalid' // 422 — parameter validation failed
  | 'bad-request' // 400 — malformed request
  | 'server' // 5xx — Yuque internal error
  | 'network' // fetch rejected (DNS/TLS/conn)
  | 'unknown'

/** Structured error thrown for every non-2xx / network failure. */
export class YuqueApiError extends Error {
  readonly kind: YuqueErrorKind
  readonly status: number | null
  /** Parsed `detail`/`message` from the Yuque error body when available. */
  readonly detail: string | undefined

  constructor(kind: YuqueErrorKind, message: string, status: number | null, detail?: string) {
    super(message)
    this.name = 'YuqueApiError'
    this.kind = kind
    this.status = status
    this.detail = detail
  }
}

/** Configuration for {@link createYuqueHttp}. */
export interface YuqueHttpOptions {
  /** Yuque personal/team token (`X-Auth-Token`). */
  token: string
  /** API base URL (default: official v2 endpoint). */
  baseUrl?: string
  /** Client-side request rate cap (default 3/s — Yuque compliance). */
  rateLimitPerSec?: number
  /** Max concurrent in-flight requests (default 2). */
  maxConcurrency?: number
  /** User-Agent value (Yuque rejects requests without it). */
  userAgent?: string
  /** How many times a 429 is retried (default 3). */
  maxRateRetries?: number
  /** Base delay for exponential backoff (default 1000 ms). */
  retryBaseDelayMs?: number
  /** Cap for backoff delay (default 10000 ms). */
  retryMaxDelayMs?: number
  /** Test seam: fetch implementation (default global fetch). */
  fetchImpl?: typeof fetch
  /** Test seam: async sleep (default setTimeout). */
  sleep?: (ms: number) => Promise<void>
  /** Test seam: monotonic-ish clock (default Date.now). */
  now?: () => number
}

/** Parsed JSON body + transport metadata of one request. */
export interface YuqueHttpResult<T = unknown> {
  status: number
  /** Parsed JSON (Yuque envelope intact — adapter unwraps per endpoint). */
  body: T
  /** Rate-limit snapshot from response headers, or null when absent. */
  rateLimit: RateLimit | null
}

/** Handle returned by {@link createYuqueHttp}. */
export interface YuqueHttp {
  /**
   * Perform one throttled, retried GET/POST. Throws {@link YuqueApiError} on
   * non-2xx (after 429 retries) or on network failure.
   */
  request<T = unknown>(path: string, init?: RequestInit): Promise<YuqueHttpResult<T>>
  /** Swap the auth token (used by `testConnection` with a candidate token). */
  setToken(token: string): void
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function classifyStatus(status: number): YuqueErrorKind {
  if (status === 400) return 'bad-request'
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 422) return 'invalid'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server'
  return 'unknown'
}

/** Extract a human-readable detail from a Yuque error JSON body. */
function extractDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const raw = record.detail ?? record.message
  return typeof raw === 'string' ? raw : undefined
}

/**
 * Bounded semaphore (FIFO) used to cap concurrent requests.
 */
class Semaphore {
  private readonly slots: number
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(slots: number) {
    this.slots = slots
  }

  async acquire(): Promise<void> {
    if (this.active < this.slots) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.active--
    }
  }
}

/** Create a Yuque HTTP client with throttling, retries and error mapping. */
export function createYuqueHttp(options: YuqueHttpOptions): YuqueHttp {
  const baseUrl = (options.baseUrl ?? YUQUE_BASE_URL).replace(/\/+$/, '')
  const rateLimitPerSec = options.rateLimitPerSec ?? 3
  if (rateLimitPerSec <= 0) throw new Error('rateLimitPerSec must be > 0')
  const intervalMs = 1000 / rateLimitPerSec
  const maxConcurrency = options.maxConcurrency ?? 2
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const maxRateRetries = options.maxRateRetries ?? 3
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 1000
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 10_000
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now

  const semaphore = new Semaphore(maxConcurrency)
  // Token bucket: next slot opening on the injected clock.
  let nextSlotAt = 0
  let token = options.token

  async function acquireSlot(): Promise<void> {
    const nowMs = now()
    // Reserve the next slot BEFORE sleeping so concurrent callers see the
    // already-advanced bucket (token-bucket semantics under contention).
    const start = Math.max(nextSlotAt, nowMs)
    nextSlotAt = start + intervalMs
    const wait = start - nowMs
    if (wait > 0) await sleep(wait)
  }

  async function request<T = unknown>(path: string, init?: RequestInit): Promise<YuqueHttpResult<T>> {
    const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers = new Headers(init?.headers)
    headers.set('X-Auth-Token', token)
    headers.set('User-Agent', userAgent)
    headers.set('Accept', 'application/json')

    let fetchError: unknown
    let fetchResponse: Response | undefined
    for (let attempt = 0; ; attempt++) {
      await semaphore.acquire()
      try {
        await acquireSlot()
        let response: Response
        try {
          response = await fetchImpl(url, { ...init, headers, redirect: 'follow' })
        } catch (err) {
          fetchError = err
          break
        }
        if (response.status === 429 && attempt < maxRateRetries) {
          const retryAfter = parseRetryAfterSeconds(response)
          const backoff = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** attempt)
          const delay = retryAfter !== undefined ? Math.min(retryAfter * 1000, retryMaxDelayMs) : backoff
          response.body?.cancel().catch(() => undefined)
          await sleep(delay)
          continue
        }
        fetchResponse = response
        break
      } finally {
        semaphore.release()
      }
    }

    if (fetchError !== undefined) {
      throw new YuqueApiError('network', `network error: ${String(fetchError)}`, null)
    }
    const response = fetchResponse as Response
    const rateLimit = readRateLimit(response.headers)
    const text = await response.text()
    let body: unknown = undefined
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text // non-JSON (HTML error page etc.)
      }
    }
    if (!response.ok) {
      const detail = extractDetail(body)
      throw new YuqueApiError(
        classifyStatus(response.status),
        detail ?? `Yuque API ${response.status}`,
        response.status,
        detail,
      )
    }
    return { status: response.status, body: body as T, rateLimit }
  }

  return {
    request,
    setToken(next: string) {
      token = next
    },
  }
}

function parseRetryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  // Retry-After may be an HTTP-date; honor only the numeric form.
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined
}

function readRateLimit(headers: Headers): RateLimit | null {
  const limitRaw = headers.get('x-ratelimit-limit')
  const remainingRaw = headers.get('x-ratelimit-remaining')
  // Some endpoints (e.g. /hello) do not carry the headers at all.
  if (limitRaw === null || remainingRaw === null) return null
  const limit = Number(limitRaw)
  const remaining = Number(remainingRaw)
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null
  return { limit, remaining }
}

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Extra attempts after the first failure (0 = single run). */
  retries: number
  /** First retry delay; doubled per attempt (exponential). */
  baseDelayMs: number
  /** Delay cap (default: no cap). */
  maxDelayMs?: number
  /** Test seam: sleep (default setTimeout). */
  sleep?: (ms: number) => Promise<void>
  /** Decide whether `err` is retryable (default: any YuqueApiError). */
  shouldRetry?: (err: unknown) => boolean
}

/**
 * Run `fn` with finite exponential backoff — used for the intermittent
 * 404s Yuque sometimes returns for doc details. Re-throws the last error
 * after `retries` failures; non-retryable errors surface immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  const shouldRetry = options.shouldRetry ?? (() => true)
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= options.retries || !shouldRetry(err)) throw err
      const delay = Math.min(options.maxDelayMs ?? Infinity, options.baseDelayMs * 2 ** attempt)
      await sleep(delay)
    }
  }
}