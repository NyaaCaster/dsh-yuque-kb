/**
 * Browser-half wire contract for the /api/dsh-yuque-kb route family.
 * Mirrors the Host contract in `.ref/开发计划-SSOT.md` §3.2; the Host half
 * is the single source of truth at runtime, these types are the client face.
 */

/** One user summary returned by the connection test. */
export interface YuqueUserInfo {
  login: string
  name: string
  booksCount: number
}

/** Result of POST /test. */
export type TestResult =
  | { ok: true; user: YuqueUserInfo }
  | { ok: false; error: string }

/** One knowledge-base (repo) node with its synced document list. */
export interface RepoNode {
  namespace: string
  name: string
  type: string
  enabled: boolean
  updatedAt: number | null
  itemsCount: number
  docs: DocNode[]
}

/** One document under a repo. */
export interface DocNode {
  docId: string
  slug: string
  title: string
  path: string
  enabled: boolean
  updatedAt: number | null
  synced: boolean
}

/** One team group with its repos (teams only when the account has access). */
export interface TeamNode {
  login: string
  name: string
  repos: RepoNode[]
}

/** Result of GET /tree. */
export interface TreePayload {
  sources: { my: RepoNode[]; teams: TeamNode[] }
  lastSyncAt: number | null
  rateRemaining: number | null
  tokenConfigured: boolean
}

/** Request body of POST /toggle. */
export interface ToggleRequest {
  kind: 'repo' | 'doc'
  id: string
  enabled: boolean
}

/** Request body of POST /token (token written through the Host settings layer). */
export interface TokenWriteRequest {
  token: string
}

/** Progress snapshot of the running sync. */
export interface SyncProgress {
  phase: string
  repo?: string
  done: number
  total: number
  errors: string[]
}

/** Result of GET /status. */
export interface StatusPayload {
  syncing: boolean
  progress: SyncProgress | null
  lastSyncAt: number | null
  rateRemaining: number | null
  tokenConfigured: boolean
}

/** Result of POST /sync. */
export interface SyncResult {
  ok: boolean
  jobId?: string
  error?: string
}