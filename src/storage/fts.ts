/**
 * FTS5 full-text index for synced Yuque doc bodies (SSOT §3.4).
 *
 * Backing store is Node's built-in `node:sqlite` (`DatabaseSync`) — zero
 * native dependencies, same choice as the official session-query SQLite
 * package. The schema mirrors that reference implementation: a STRICT meta
 * table (`kb_meta`, one row per doc) plus an FTS5 virtual table (`kb_fts`,
 * one row per chunk, `doc_id`/`block_type` UNINDEXED) joined on query.
 *
 * Tokenizer probe (P3 首验, Node 22.19+ / SQLite 3.50): `trigram` builds
 * fine and gives CJK substring matching, BUT tokens shorter than 3
 * characters cannot match at all (trigram emits no token for 2-char text —
 * e.g. `MATCH '语雀'` returns nothing). `openIndex` therefore probes once at
 * open, stores the result, and `search` compensates:
 * - trigram: tokens ≥ 3 chars go through MATCH (bm25-ranked); tokens < 3
 *   chars are applied as `instr` sub-string predicates so 2-char CJK words
 *   like `语雀` still hit.
 * - fallback (`unicode61`, when trigram is unavailable): MATCH has no CJK
 *   sub-string semantics (an unsegmented CJK run is one token), so the whole
 *   query runs as an `instr` scan with LIKE-style scoring (occurrence count,
 *   then bm25 as tiebreak). Rows are de-duplicated per doc via a window
 *   function; `total` is a distinct-doc count and `truncated` is honest
 *   (query ran with limit+1).
 */

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chunkMarkdown, DEFAULT_MAX_CHARS } from './chunk.ts'

/** SQLite application id distinguishing `kb_fts` databases from foreign files. */
export const KB_APPLICATION_ID = 0x594B4654 // ASCII "YKFT"
/** Index schema version; bumped versions reset the derived tables in place. */
export const KB_SCHEMA_VERSION = 1
/** Result page-size ceiling, matching the `kb_search` tool contract (≤ 20). */
export const KB_SEARCH_MAX_LIMIT = 20
/** Default page size, matching the `kb_search` tool contract. */
export const KB_SEARCH_DEFAULT_LIMIT = 8
/** Snippet length ceiling in code points (contract: ~200 chars). */
export const KB_SNIPPET_CHARS = 200

/** Marker inserted before a match by `highlight` (collision-free noncharacters). */
const HIGHLIGHT_START = '\uFDD0'
/** Marker inserted after a match by `highlight` (collision-free noncharacters). */
const HIGHLIGHT_END = '\uFDD1'

/** Tokenizer kinds supported by the FTS5 index. */
export type TokenizerKind = 'trigram' | 'unicode61'

/** One doc pushed into the index; the body is chunked internally. */
export interface IndexedDoc {
  /** Opaque doc key (same value as the domain `docs` table key). */
  docId: string
  /** Doc title, indexed and bm25-weighted above body text. */
  title: string
  /** Breadcrumb path, indexed and bm25-weighted above body text. */
  path: string
  /** Repo identity (namespace + name), indexed for repo scoping. */
  repo: string
  /** Epoch ms of the indexed content. */
  updatedAt: number
  /** Raw markdown body; chunked by structure before indexing. */
  body: string
}

/** Search options. */
export interface KbSearchOptions {
  /** Free-text query; whitespace-trimmed before use. */
  query: string
  /** Page size, 1..{@link KB_SEARCH_MAX_LIMIT}; defaults to {@link KB_SEARCH_DEFAULT_LIMIT}. */
  limit?: number
  /** Restrict hits to one repo (exact match on the indexed repo column). */
  repo?: string
  /**
   * Doc ids allowed to surface (enabled filter). When given and empty,
   * search returns no hits; when `undefined`, no filter applies.
   */
  enabledIds?: ReadonlySet<string>
}

/** One search hit. */
export interface KbSearchItem {
  /** Opaque doc key. */
  docId: string
  /** Doc title. */
  title: string
  /** Breadcrumb path. */
  path: string
  /** Repo identity. */
  repo: string
  /** Epoch ms of the indexed content. */
  updatedAt: number
  /** Bounded context window around the first match (~200 chars). */
  snippet: string
}

/** Search result with honest truncation. */
export interface KbSearchResult {
  /** Total distinct docs matching the query (before paging). */
  total: number
  /** `true` when more hits exist beyond the returned page. */
  truncated: boolean
  /** Ordered hits; at most `limit` items. */
  items: KbSearchItem[]
}

/** Options for {@link openIndex}. */
export interface OpenIndexOptions {
  /**
   * Force a tokenizer instead of probing. Testing escape hatch and the
   * documented fallback path (`unicode61`); defaults to probing.
   */
  tokenizer?: TokenizerKind
  /** Paragraph chunk ceiling passed to the chunker; defaults to 512. */
  maxChars?: number
}

/** Opened FTS5 index handle. */
export interface KbIndex {
  /** Absolute database path (or `:memory:`). */
  readonly dbPath: string
  /** Tokenizer in use for this index. */
  readonly tokenizer: TokenizerKind
  /**
   * Upsert docs in one transaction: stale rows for each doc id are removed,
   * then the meta row plus one FTS row per structural chunk are inserted.
   * @param docs - docs to write.
   */
  upsertDocs(docs: readonly IndexedDoc[]): void
  /**
   * Remove docs (meta + all chunk rows) in one transaction.
   * @param docIds - ids to delete; absent ids are no-ops.
   */
  removeDocs(docIds: readonly string[]): void
  /** Run a full-text search (see module docs for tokenizer specifics). */
  search(options: KbSearchOptions): KbSearchResult
  /** Total indexed docs (meta rows). */
  countDocs(): number
  /** Close the underlying database; further calls throw. */
  close(): void
}

/**
 * Probe whether the given connection supports the FTS5 `trigram` tokenizer.
 * The probe table is created then dropped; an FTS5 build without the module
 * or tokenizer raises, which reports `unicode61` as the fallback.
 * @param db - open connection (may be `:memory:`).
 * @returns the tokenizer this build supports.
 */
export function detectTokenizer(db: DatabaseSync): TokenizerKind {
  try {
    db.exec("CREATE VIRTUAL TABLE _kb_fts_probe USING fts5(title, text, tokenize = 'trigram')")
  } catch {
    // Unknown tokenizer (or missing FTS5 module): fall back. An FTS5-less
    // build also fails the unicode61 creation in `openIndex` and fails loud.
    return 'unicode61'
  }
  db.exec('DROP TABLE _kb_fts_probe')
  return 'trigram'
}

/**
 * Open (creating the parent directory when needed) and initialize the index
 * database: validate the application id, reset the derived tables on schema
 * version change, probe the tokenizer, then create the schema.
 * @param dbPath - database file path or `:memory:`.
 * @param options - open options.
 * @returns the opened index handle.
 * @throws when the file belongs to another application or is an
 * unrecognized non-empty database.
 */
export async function openIndex(dbPath: string, options?: OpenIndexOptions): Promise<KbIndex> {
  const actual = dbPath === ':memory:' ? dbPath : resolve(dbPath)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true })
  }
  const db = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as {
      application_id: number
    }
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (applicationId !== 0 && applicationId !== KB_APPLICATION_ID) {
      throw new Error(`index database at "${actual}" belongs to another application`)
    }
    const userTables = listUserTables(db)
    if (applicationId === 0 && userTables.length > 0) {
      throw new Error(`index database at "${actual}" is not an empty or recognized index`)
    }
    if (applicationId === KB_APPLICATION_ID && version !== KB_SCHEMA_VERSION) {
      resetIndexSchema(db)
    }
    if (actual !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
    }
    db.exec(`PRAGMA application_id = ${KB_APPLICATION_ID}`)
    const tokenizer = options?.tokenizer ?? detectTokenizer(db)
    const stored = storedTokenizerOf(db)
    if (stored !== undefined && stored !== tokenizer) {
      // Runtime upgraded (e.g. a newer SQLite gained trigram): rebuild the
      // virtual table so the on-disk tokenizer matches the probed one.
      db.exec('DROP TABLE IF EXISTS kb_fts')
    }
    ensureIndexSchema(db, tokenizer)
    db.exec(`PRAGMA user_version = ${KB_SCHEMA_VERSION}`)
    return new SqliteKbIndex(actual, db, tokenizer, options?.maxChars ?? DEFAULT_MAX_CHARS)
  } catch (error) {
    db.close()
    throw error
  }
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function resetIndexSchema(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS kb_fts')
  db.exec('DROP TABLE IF EXISTS kb_meta')
  db.exec('PRAGMA user_version = 0')
}

function ensureIndexSchema(db: DatabaseSync, tokenizer: TokenizerKind): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_meta (
      doc_id     TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      path       TEXT NOT NULL,
      repo       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      title,
      path,
      repo,
      text,
      doc_id UNINDEXED,
      block_type UNINDEXED,
      tokenize = '${tokenizer}'
    )
  `)
}

/** Tokenizer stamped in the on-disk `kb_fts` DDL, when the table exists. */
function storedTokenizerOf(db: DatabaseSync): TokenizerKind | undefined {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kb_fts'",
  ).get() as { sql: string | null } | undefined
  if (row === undefined || row.sql === null) return undefined
  const match = /tokenize\s*=\s*'(\w+)'/i.exec(row.sql)
  if (match?.[1] === 'trigram') return 'trigram'
  if (match?.[1] === 'unicode61') return 'unicode61'
  return undefined
}

/** One FTS hit row before doc de-duplication. */
interface HitRow {
  doc_id: string
  title: string
  path: string
  repo: string
  updated_at: number
  marked_text: string
}

/** Whitespace-separated query tokens, empty-filtered. */
function splitQuery(query: string): string[] {
  return query.trim().replace(/\s+/gu, ' ').split(' ').filter(token => token.length > 0)
}

/** Quote caller text as one FTS5 phrase so query syntax stays inert data. */
function quoteFtsData(token: string): string {
  return `"${token.replaceAll('"', '""')}"`
}

/** SQLite-alias-safe column surface of a search hit. */
const HIT_COLUMNS = `f.doc_id AS doc_id, f.title AS title, f.path AS path, f.repo AS repo,
      m.updated_at AS updated_at`

/** Build one `instr(col, ?) > 0` predicate and one binding per token. */
function likePredicates(tokens: readonly string[], params: (string | number)[]): string[] {
  const clauses: string[] = []
  for (const token of tokens) {
    clauses.push('(instr(f.text, ?) > 0 OR instr(f.title, ?) > 0 OR instr(f.path, ?) > 0 OR instr(f.repo, ?) > 0)')
    params.push(token, token, token, token)
  }
  return clauses
}

/** Occurrence-count of a token in a string; 0 for the empty needle. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = 0
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) break
    count += 1
    index = found + needle.length
  }
  return count
}

/** Bounded snippet around the match markers, or the first token occurrence. */
function makeSnippet(markedText: string, tokens: readonly string[], maxChars: number): string {
  const characters: string[] = []
  let matchStart: number | undefined
  for (const character of markedText) {
    if (character === HIGHLIGHT_START) {
      matchStart ??= characters.length
      continue
    }
    if (character === HIGHLIGHT_END) continue
    if (/\s/u.test(character)) {
      if (characters.length > 0 && characters.at(-1) !== ' ') characters.push(' ')
    } else {
      characters.push(character)
    }
  }
  while (characters.at(-1) === ' ') characters.pop()
  const clean = characters.join('')
  if (matchStart === undefined) {
    // No FTS marker (title/path hit or LIKE fallback): center on the first
    // token occurrence in the body text.
    for (const token of tokens) {
      const found = clean.indexOf(token)
      if (found !== -1) {
        matchStart = Array.from(clean.slice(0, found)).length
        break
      }
    }
    matchStart ??= 0
  }
  const codePoints = Array.from(clean)
  if (codePoints.length <= maxChars) return clean
  const centered = Math.min(matchStart, codePoints.length - 1)
  let start = Math.max(0, centered - Math.floor(maxChars / 3))
  const prefix = start > 0 ? '…' : ''
  let end = Math.min(codePoints.length, start + maxChars - prefix.length - 1)
  const suffix = end < codePoints.length ? '…' : ''
  end = end - suffix.length
  if (end <= start) {
    start = centered
    end = Math.min(codePoints.length, start + maxChars)
  }
  return `${prefix}${codePoints.slice(start, end).join('')}${suffix}`
}

/** Bound the requested page size to the contract window. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return KB_SEARCH_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), KB_SEARCH_MAX_LIMIT)
}

/** Split a possibly-large id set into bounded `doc_id IN (...)` chunks. */
function buildIdClauses(ids: readonly string[], params: (string | number)[]): string[] {
  const CHUNK = 500
  const clauses: string[] = []
  for (let index = 0; index < ids.length; index += CHUNK) {
    const slice = ids.slice(index, index + CHUNK)
    clauses.push(`f.doc_id IN (${slice.map(() => '?').join(', ')})`)
    params.push(...slice)
  }
  return clauses
}

/** Concrete {@link KbIndex} over one open `DatabaseSync`. */
class SqliteKbIndex implements KbIndex {
  private closed = false

  constructor(
    readonly dbPath: string,
    private readonly db: DatabaseSync,
    readonly tokenizer: TokenizerKind,
    private readonly maxChars: number,
  ) {}

  upsertDocs(docs: readonly IndexedDoc[]): void {
    const db = this.requireDb()
    const deleteFts = db.prepare('DELETE FROM kb_fts WHERE doc_id = ?')
    const deleteMeta = db.prepare('DELETE FROM kb_meta WHERE doc_id = ?')
    const insertMeta = db.prepare(
      'INSERT INTO kb_meta (doc_id, title, path, repo, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    const insertFts = db.prepare(
      'INSERT INTO kb_fts (title, path, repo, text, doc_id, block_type) VALUES (?, ?, ?, ?, ?, ?)',
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const doc of docs) {
        deleteFts.run(doc.docId)
        deleteMeta.run(doc.docId)
        insertMeta.run(doc.docId, doc.title, doc.path, doc.repo, doc.updatedAt)
        // Row 0 carries the metadata columns so title/path/repo MATCH too.
        insertFts.run(doc.title, doc.path, doc.repo, '', doc.docId, 'meta')
        for (const chunk of chunkMarkdown(doc.body, { maxChars: this.maxChars })) {
          insertFts.run(doc.title, doc.path, doc.repo, chunk.text, doc.docId, chunk.type)
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  removeDocs(docIds: readonly string[]): void {
    const db = this.requireDb()
    const deleteFts = db.prepare('DELETE FROM kb_fts WHERE doc_id = ?')
    const deleteMeta = db.prepare('DELETE FROM kb_meta WHERE doc_id = ?')
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const docId of docIds) {
        deleteFts.run(docId)
        deleteMeta.run(docId)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  search(options: KbSearchOptions): KbSearchResult {
    const db = this.requireDb()
    const tokens = splitQuery(options.query)
    if (tokens.length === 0) {
      return { total: 0, truncated: false, items: [] }
    }
    const limit = normalizeLimit(options.limit)
    const enabledIds = options.enabledIds
    if (enabledIds !== undefined && enabledIds.size === 0) {
      return { total: 0, truncated: false, items: [] }
    }

    const params: (string | number)[] = []
    const conditions: string[] = []
    if (this.tokenizer === 'trigram') {
      // MATCH needs ≥ 3 chars per token (trigram emits no shorter tokens);
      // shorter CJK/ASCII tokens fall back to sub-string predicates.
      const matchTokens = tokens.filter(token => token.length >= 3)
      const shortTokens = tokens.filter(token => token.length < 3)
      if (matchTokens.length > 0) {
        conditions.push('kb_fts MATCH ?')
        params.push(matchTokens.map(quoteFtsData).join(' '))
      }
      conditions.push(...likePredicates(shortTokens, params))
    } else {
      // unicode61 cannot sub-string-match unsegmented CJK runs; the whole
      // query runs as an instr scan scored by occurrence count. MATCH is
      // intentionally not used: instr sub-strings are a superset of its
      // word matches and keep the ranking uniform.
      conditions.push(...likePredicates(tokens, params))
    }
    if (options.repo !== undefined) {
      conditions.push('f.repo = ?')
      params.push(options.repo)
    }
    if (enabledIds !== undefined) {
      conditions.push(...buildIdClauses([...enabledIds], params))
    }
    const where = conditions.join(' AND ')

    const totalRow = db.prepare(`
      SELECT COUNT(DISTINCT f.doc_id) AS total
      FROM kb_fts AS f
      JOIN kb_meta AS m ON m.doc_id = f.doc_id
      WHERE ${where}
    `).all(...params) as Array<{ total: number }>
    const total = totalRow[0]?.total ?? 0
    if (total === 0) {
      return { total: 0, truncated: false, items: [] }
    }

    const likeScore = tokens.map(() => '(instr(f.text, ?) > 0) + (instr(f.title, ?) > 0) + (instr(f.path, ?) > 0) + (instr(f.repo, ?) > 0)')
    const scoreParams = tokens.flatMap(token => [token, token, token, token])
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT ${HIT_COLUMNS},
          highlight(kb_fts, 3, ?, ?) AS marked_text,
          bm25(kb_fts, 6.0, 3.0, 1.0, 1.0) AS rank,
          ${likeScore.join(' + ')} AS like_score
        FROM kb_fts AS f
        JOIN kb_meta AS m ON m.doc_id = f.doc_id
        WHERE ${where}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY doc_id
          ORDER BY like_score DESC, rank ASC, doc_id ASC
        ) AS rn
        FROM candidates
      )
      SELECT doc_id, title, path, repo, updated_at, marked_text
      FROM ranked
      WHERE rn = 1
      ORDER BY like_score DESC, rank ASC, doc_id ASC
      LIMIT ? OFFSET 0
    `)
    // Binding order must follow the `?` occurrence order in the SQL text:
    // highlight (2) → like_score expression (SELECT list, before WHERE) →
    // WHERE conditions → LIMIT.
    const hitRows = rows.all(
      HIGHLIGHT_START,
      HIGHLIGHT_END,
      ...scoreParams,
      ...params,
      limit + 1,
    ) as unknown as HitRow[]

    const truncated = hitRows.length > limit
    const page = hitRows.slice(0, limit)
    return {
      total,
      truncated,
      items: page.map(row => ({
        docId: row.doc_id,
        title: row.title,
        path: row.path,
        repo: row.repo,
        updatedAt: row.updated_at,
        snippet: makeSnippet(row.marked_text, tokens, KB_SNIPPET_CHARS),
      })),
    }
  }

  countDocs(): number {
    const row = this.requireDb().prepare('SELECT COUNT(*) AS count FROM kb_meta').get() as {
      count: number
    }
    return row.count
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private requireDb(): DatabaseSync {
    if (this.closed) {
      throw new Error('FTS index is closed')
    }
    return this.db
  }
}