/**
 * Browser-side API client for the /api/dsh-yuque-kb route family.
 * Plain same-origin fetch against the Host routes — the external-plugin
 * sanctioned path (dsh-ssh pattern); the official Remote gateway is not
 * extended by third-party plugins.
 */
import type {
  StatusPayload,
  SyncResult,
  TestResult,
  ToggleRequest,
  TokenWriteRequest,
  TreePayload,
} from './types.ts'

const API_ROOT = '/api/dsh-yuque-kb'

/** One structured failure from the Host side. */
export class KbApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'KbApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = await response.json() as { error?: string }
      if (typeof body.error === 'string' && body.error.length > 0) message = body.error
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new KbApiError(message, response.status)
  }
  return await response.json() as T
}

export interface KbApi {
  test(): Promise<TestResult>
  readTree(refresh: boolean): Promise<TreePayload>
  toggle(request: ToggleRequest): Promise<{ ok: boolean }>
  writeToken(token: string): Promise<{ ok: boolean }>
  startSync(repos?: readonly string[]): Promise<SyncResult>
  readStatus(): Promise<StatusPayload>
}

/** Create the API client (plain functions, no shared state). */
export function createKbApi(): KbApi {
  return {
    async test() {
      return request<TestResult>('/test', { method: 'POST', body: JSON.stringify({}) })
    },
    async readTree(refresh: boolean) {
      return request<TreePayload>(`/tree?refresh=${refresh ? 'true' : 'false'}`)
    },
    async toggle(payload: ToggleRequest) {
      return request<{ ok: boolean }>('/toggle', { method: 'POST', body: JSON.stringify(payload) })
    },
    async writeToken(token: string) {
      return request<{ ok: boolean }>('/token', { method: 'POST', body: JSON.stringify({ token } satisfies TokenWriteRequest) })
    },
    async startSync(repos) {
      return request<SyncResult>('/sync', { method: 'POST', body: JSON.stringify({ repos: repos ?? undefined }) })
    },
    async readStatus() {
      return request<StatusPayload>('/status')
    },
  }
}