/**
 * Yuque OpenAPI entity types.
 *
 * Field sets are based on live measurements recorded in
 * `.ref/yuque-api-research.md`; unknown / unmeasured fields stay optional so
 * the adapter never assumes more than the API actually returns. All types are
 * read-only interfaces (we never write to Yuque).
 */

/** Rate-limit window reported by Yuque response headers (per hour). */
export interface RateLimit {
  /** Total requests allowed per window. */
  limit: number
  /** Requests remaining in the current window. */
  remaining: number
}

/** The account owning repos / authoring docs (`/api/v2/user`). */
export interface YuqueUser {
  id: number
  /** URL path segment, e.g. `nyaa-rgeis`. */
  login: string
  name: string
  description?: string
  avatar_url?: string
  /** Total knowledge bases (repos) the user can see. */
  books_count?: number
  /** Public knowledge bases count. */
  public_books_count?: number
  followers_count?: number
  following_count?: number
  created_at?: string
  updated_at?: string
}

/** A team (`/users/{id}/groups`) the token can access. */
export interface YuqueGroup {
  id: number
  /** URL path segment of the team. */
  login: string
  name: string
  description?: string
  avatar_url?: string
  members_count?: number
  public_repos_count?: number
  created_at?: string
  updated_at?: string
}

/** A knowledge base (repo), personal or team-owned. */
export interface YuqueRepo {
  id: number
  /** Usually `Book`. */
  type: string
  slug: string
  name: string
  /** `{login}/{slug}` — the canonical repo identifier. */
  namespace: string
  /** Owner user object (present for personal repos). */
  user?: YuqueUser
  /** Owner team object (present for team repos). */
  group?: YuqueGroup
  description?: string
  /** Number of docs in the repo. */
  items_count: number
  /** Latest content change timestamp (ISO 8601 UTC) — incremental sync key. */
  content_updated_at?: string
  public: boolean
  /** TOC as a YAML string (from repo detail; may be absent in list). */
  toc_yml?: string
  likes_count?: number
  watches_count?: number
  created_at?: string
  updated_at?: string
}

/** A node of the repo TOC (`/repos/{namespace}/toc`, flat array). */
export interface YuqueTocNode {
  /** Stable node id (generated client-side by Yuque). */
  uuid: string
  /** DOC = document, TITLE = grouping heading, LINK = external link. */
  type: 'DOC' | 'TITLE' | 'LINK'
  title: string
  /** Absolute page URL (docs often carry it). */
  url?: string
  /** Doc slug when type is DOC. */
  slug?: string
  /** Numeric doc id when type is DOC. */
  doc_id?: number
  level: number
  depth?: number
  prev_uuid?: string
  sibling_uuid?: string
  child_uuid?: string
  parent_uuid?: string
}

/** One document row of the docs list (`/repos/{namespace}/docs`). */
export interface YuqueDocSummary {
  id: number
  slug: string
  title: string
  book_id: number
  user_id?: number
  /** `markdown` | `lake` | `html` | `lakesheet` (see research notes). */
  format?: string
  word_count?: number
  status?: number
  public?: boolean
  created_at?: string
  /** Last edit time (ISO 8601 UTC). */
  updated_at?: string
  /** Content change time (ISO 8601 UTC) — the incremental diff key. */
  content_updated_at?: string
}

/** Full document detail (`/repos/{namespace}/docs/{slug}`, incl. bodies). */
export interface YuqueDocDetail {
  id: number
  slug: string
  title: string
  book_id: number
  user_id?: number
  format?: string
  /** Markdown source (with `?raw=1`, or when format=markdown). */
  body?: string | null
  /** HTML rendering. */
  body_html?: string | null
  /** Lake editor JSON source. */
  body_lake?: string | null
  /** Sheet JSON source for lakesheet docs. */
  body_sheet?: string | null
  body_draft?: string | null
  word_count?: number
  status?: number
  content_updated_at?: string
  created_at?: string
  updated_at?: string
}

/** Raw sheet body structure (`body_sheet` JSON: {version,data:[...]}). */
export interface YuqueLakeSheet {
  version: number
  data: YuqueLakeSheetTable[]
}

/** One sheet within a lakesheet document. */
export interface YuqueLakeSheetTable {
  name: string
  index: number
  rowCount: number
  colCount: number
  /** Row-major cell values (may nest rich objects). */
  table: unknown[][]
}

/** Doc reference used by the incremental diff (slug + change timestamp). */
export interface DocRef {
  slug: string
  updatedAt?: string
}

/** Result of diffing local doc list against the remote doc list. */
export interface DocDiff {
  /** Present remotely, absent locally. */
  added: DocRef[]
  /** Present both sides with a newer remote change timestamp. */
  updated: DocRef[]
  /** Present both sides, unchanged (same slug and timestamp). */
  unchanged: DocRef[]
  /** Present locally, gone remotely. */
  removed: DocRef[]
}