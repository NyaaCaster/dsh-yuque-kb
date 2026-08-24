/**
 * HTTP transport unit tests — deterministic via mocked fetch + fake timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createYuqueHttp,
  withRetry,
  YuqueApiError,
  YUQUE_BASE_URL,
  type YuqueHttpOptions,
} from '../../src/yuque/http.ts'

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<YuqueHttpOptions> = {},
) {
  return createYuqueHttp({
    token: 'test-token',
    fetchImpl,
    rateLimitPerSec: 30, // fast throttle by default; override in specific tests
    maxConcurrency: 4,
    ...overrides,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createYuqueHttp — request basics', () => {
  it('sends auth + UA headers and follows redirects', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse({ data: { ok: 1 } }),
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.request('/hello')
    expect(result.body).toEqual({ data: { ok: 1 } })
    const call = fetchImpl.mock.calls[0] as [RequestInfo | URL, RequestInit]
    const [, init] = call
    const headers = new Headers(init.headers)
    expect(headers.get('x-auth-token')).toBe('test-token')
    expect(headers.get('user-agent')).toBeDefined()
    expect(init.redirect).toBe('follow')
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${YUQUE_BASE_URL}/hello`)
  })

  it('surfaces rate-limit headers when present', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: 1 }, 200, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4985',
      }),
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.request('/user')
    expect(result.rateLimit).toEqual({ limit: 5000, remaining: 4985 })
  })

  it('returns null rateLimit when headers are missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { message: 'Hello' } }))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.request('/hello')
    expect(result.rateLimit).toBeNull()
  })

  it('classifies HTTP errors into structured YuqueApiError', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'auth', 'Bad Token'],
      [403, 'forbidden', 'Forbidden'],
      [404, 'not-found', 'Not Found'],
      [422, 'invalid', '参数错误'],
      [429, 'rate-limited', 'Too Many Requests'],
      [500, 'server', 'Internal Error'],
      [418, 'unknown', 'teapot'],
    ]
    for (const [status, kind, detail] of cases) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ detail }, status),
      )
      // maxRateRetries 0: skip the 429 backoff sleeps for the classification loop.
      const client = makeClient(fetchImpl as unknown as typeof fetch, { maxRateRetries: 0 })
      const promise = client.request(`/status/${status}`)
      await expect(promise).rejects.toMatchObject({
        name: 'YuqueApiError',
        kind,
        status,
        detail,
      })
    }
  })

  it('maps fetch rejections to network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const promise = client.request('/user')
    await expect(promise).rejects.toMatchObject({ kind: 'network', status: null })
  })
})

describe('throttling + concurrency', () => {
  it('spaces requests by rateLimitPerSec (3 req/s) using the injected clock', async () => {
    vi.useFakeTimers()
    const timestamps: number[] = []
    const fetchImpl = vi.fn(async () => {
      timestamps.push(Date.now())
      return jsonResponse({ data: 1 })
    })
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      rateLimitPerSec: 3,
      maxConcurrency: 8,
    })
    const pending = Promise.all([client.request('/a'), client.request('/b'), client.request('/c')])
    await vi.advanceTimersByTimeAsync(2000)
    await pending
    expect(timestamps).toHaveLength(3)
    // 1000/3 ≈ 333ms between slot openings.
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(330)
    expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(330)
  })

  it('caps in-flight requests at maxConcurrency', async () => {
    vi.useFakeTimers()
    const release: Array<() => void> = []
    let active = 0
    let maxActive = 0
    const fetchImpl = vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => release.push(() => {
        active--
        resolve()
      }))
      return jsonResponse({ data: 1 })
    })
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      rateLimitPerSec: 100,
      maxConcurrency: 2,
    })
    const results = Promise.all([1, 2, 3, 4, 5, 6].map((i) => client.request(`/${i}`)))
    await vi.advanceTimersByTimeAsync(200)
    expect(maxActive).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // Release the two in flight; the next two acquire slots.
    release.splice(0).forEach((r) => r())
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    release.splice(0).forEach((r) => r())
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    release.splice(0).forEach((r) => r())
    await results
    expect(maxActive).toBe(2)
  })
})

describe('429 backoff', () => {
  it('retries honoring Retry-After, then succeeds', async () => {
    vi.useFakeTimers()
    const timestamps: number[] = []
    const fetchImpl = vi.fn(async () => {
      timestamps.push(Date.now())
      if (timestamps.length === 1) return jsonResponse({ detail: 'Too Many Requests' }, 429, { 'retry-after': '1' })
      return jsonResponse({ data: 'ok' })
    })
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      rateLimitPerSec: 100,
      maxConcurrency: 4,
      maxRateRetries: 3,
    })
    const pending = client.request('/x')
    await vi.advanceTimersByTimeAsync(1100)
    const result = await pending
    expect(result.body).toEqual({ data: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // Retry-After=1s honored.
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(1000)
  })

  it('backs off exponentially without Retry-After and throws after exhausting retries', async () => {
    vi.useFakeTimers()
    const timestamps: number[] = []
    const fetchImpl = vi.fn(async () => {
      timestamps.push(Date.now())
      return jsonResponse({ detail: 'Too Many Requests' }, 429)
    })
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      rateLimitPerSec: 100,
      maxConcurrency: 4,
      maxRateRetries: 2,
      retryBaseDelayMs: 500,
      retryMaxDelayMs: 5000,
    })
    const pending = client.request('/x').catch((err) => err)
    await vi.advanceTimersByTimeAsync(5000)
    const err = await pending
    expect(err).toBeInstanceOf(YuqueApiError)
    expect((err as YuqueApiError).kind).toBe('rate-limited')
    expect(fetchImpl).toHaveBeenCalledTimes(3) // initial + 2 retries
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(500)
    expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(1000)
  })
})

describe('withRetry', () => {
  it('retries retryable failures with exponential delay', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) throw new YuqueApiError('not-found', 'nope', 404)
      return 'done'
    })
    const pending = withRetry(fn, { retries: 2, baseDelayMs: 100, maxDelayMs: 500 })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe('done')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('gives up after retries exhausted and re-throws the last error', async () => {
    vi.useFakeTimers()
    const fn = vi.fn(async () => {
      throw new YuqueApiError('not-found', 'nope', 404)
    })
    const pending = withRetry(fn, { retries: 2, baseDelayMs: 100 }).catch((err) => err)
    await vi.advanceTimersByTimeAsync(1000)
    const err = await pending
    expect(err).toMatchObject({ kind: 'not-found', status: 404 })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-matching errors when a predicate is given', async () => {
    const fn = vi.fn(async () => {
      throw new YuqueApiError('auth', 'bad token', 401)
    })
    const promise = withRetry(fn, {
      retries: 3,
      baseDelayMs: 10,
      shouldRetry: (err) => (err as YuqueApiError).kind === 'not-found',
    })
    await expect(promise).rejects.toMatchObject({ kind: 'auth' })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})