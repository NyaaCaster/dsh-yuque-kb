/**
 * `yuque-kb` storage domain: metadata (never body text) for synced repos and
 * docs, plus the sync-status global slot. Body content lives in the separate
 * FTS5 index (`src/storage/fts.ts`); the domain carries only the small
 * records the tree UI and `kb_*` tools query (SSOT §3.3).
 *
 * Design note (P3): the domain record schemas are zod, as required by
 * `@deepseek-ai/dsh-storage-domain`; table keys are branded ids
 * (`RepoId`/`DocId`) so cross-boundary references stay opaque at the type
 * level. Helper functions below are injection-friendly: they accept an
 * already-opened `Domain` handle instead of a cordis context, so callers
 * (host apply in P4) and unit tests construct or inject the handle
 * directly — IO is decoupled from cordis.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DomainError,
  defineDomain,
  domainTable,
} from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Storage domain name (SSOT §3.3 names it `yuque-kb`; the harness unit-name
 * grammar `UNIT_NAME_RE` forbids hyphens, so the domain registers as
 * `yuque_kb` — the `dsh-yuque-kb` plugin and `/api/dsh-yuque-kb` routes are
 * unaffected). */
export const DOMAIN_NAME = 'yuque_kb'

/** Domain schema version; bumping it invalidates stored media on reopen. */
export const DOMAIN_VERSION = 1

const globalSchema = z.object({
  /** Epoch ms of the last successful sync; `null` when never synced. */
  lastSyncAt: z.number().nullable(),
  /** Last observed Yuque X-RateLimit-Remaining; `null` when unknown. */
  rateRemaining: z.number().nullable(),
})

/** Global sync-status slot type. */
export type KbGlobal = z.infer<typeof globalSchema>

/** Initial global value served before the first durable write. */
export const KB_GLOBAL_INITIAL: KbGlobal = { lastSyncAt: null, rateRemaining: null }

/** Branded key schema of the `repos` table (a `string` at runtime). */
export const repoIdSchema = z.string().brand<'RepoId'>()

/** Opaque repo key. */
export type RepoId = z.infer<typeof repoIdSchema>

const repoRecordSchema = z.object({
  /** Yuque namespace login (user or team group login). */
  namespace: z.string(),
  /** Repo display name. */
  name: z.string(),
  /** Yuque repo type (e.g. `Book`, `Design`). */
  type: z.string(),
  /** Master switch: disabled repos/docs are invisible to `kb_search`. */
  enabled: z.boolean(),
  /** Owning team group login when the repo belongs to a team; `null` for personal repos. */
  team: z.string().nullable(),
  /** Epoch ms of the last indexed repo state. */
  updatedAt: z.number(),
  /** Number of docs indexed for this repo. */
  itemsCount: z.number().int(),
})

/** One repo record. */
export type RepoRecord = z.infer<typeof repoRecordSchema>

/** Branded key schema of the `docs` table (a `string` at runtime). */
export const docIdSchema = z.string().brand<'DocId'>()

/** Opaque doc key (Yuque doc id). */
export type DocId = z.infer<typeof docIdSchema>

const docRecordSchema = z.object({
  /** Owning repo key. */
  repoId: repoIdSchema,
  /** Yuque doc slug. */
  slug: z.string(),
  /** Doc title. */
  title: z.string(),
  /** Breadcrumb path derived from the repo table of contents. */
  path: z.string(),
  /** Master switch: disabled docs are invisible to `kb_search`. */
  enabled: z.boolean(),
  /** Epoch ms of the indexed doc content. */
  updatedAt: z.number(),
  /** Indexed word count (approx). */
  wordCount: z.number().int(),
  /** Number of chunks in the FTS5 index for this doc. */
  blocks: z.number().int(),
  /** Source format of the indexed body (e.g. `md`, `lake`). */
  format: z.string(),
})

/** One doc record (metadata only; body lives in the FTS5 index). */
export type DocRecord = z.infer<typeof docRecordSchema>

/** The declared `yuque-kb` domain, typed by its literal spec. */
export const kbDomainSpec = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  global: {
    schema: globalSchema,
    initial: KB_GLOBAL_INITIAL,
  },
  tables: {
    repos: domainTable<RepoId, RepoRecord>(repoRecordSchema),
    docs: domainTable<DocId, DocRecord>(docRecordSchema),
  },
})

/** Typed handle of an opened `yuque-kb` domain. */
export type KbDomain = Domain<typeof kbDomainSpec>

/**
 * Open the `yuque-kb` domain on a context that has the storage-domain
 * facility mounted, and register its close as a context effect so plugin
 * disposal releases the unit (HMR-safe; the caller owns nothing).
 * @param ctx - host plugin context with `storageDomain` available.
 * @returns the opened typed domain handle.
 * @throws when no storage domain facility is mounted (load
 * `@deepseek-ai/dsh-storage-domain` plus a `kv` backend such as
 * `@deepseek-ai/dsh-storage-sqlite` first).
 */
export async function openDomain(ctx: Context): Promise<KbDomain> {
  const facility = ctx.get('storageDomain') as DomainFacility | undefined
  if (facility === undefined) {
    throw new Error(
      'storageDomain facility is not mounted: load @deepseek-ai/dsh-storage-domain with a kv backend',
    )
  }
  const domain = await facility.open(kbDomainSpec)
  ctx.effect(() => () => {
    void domain.close()
  }, 'yuque-kb.domain')
  return domain
}

/** Read one repo record synchronously; `undefined` when absent. */
export function getRepo(domain: KbDomain, repoId: RepoId): RepoRecord | undefined {
  return domain.table('repos').get(repoId)
}

/** Durably insert or replace one repo record. */
export async function setRepo(domain: KbDomain, repoId: RepoId, record: RepoRecord): Promise<void> {
  await domain.table('repos').put(repoId, record)
}

/** Read one doc record synchronously; `undefined` when absent. */
export function getDoc(domain: KbDomain, docId: DocId): DocRecord | undefined {
  return domain.table('docs').get(docId)
}

/** Durably insert or replace one doc record. */
export async function setDoc(domain: KbDomain, docId: DocId, record: DocRecord): Promise<void> {
  await domain.table('docs').put(docId, record)
}

/**
 * Atomically flip the `enabled` flag of a repo or doc record.
 * @param domain - opened domain handle.
 * @param kind - which table the id belongs to.
 * @param id - repo or doc key.
 * @param enabled - new flag value.
 * @returns `true` when the record existed and was updated, `false` when it
 * is absent (no write performed).
 */
export async function setEnabled(
  domain: KbDomain,
  kind: 'repo' | 'doc',
  id: string,
  enabled: boolean,
): Promise<boolean> {
  try {
    if (kind === 'repo') {
      await domain.table('repos').update(id as RepoId, current => ({ ...current, enabled }))
    } else {
      await domain.table('docs').update(id as DocId, current => ({ ...current, enabled }))
    }
    return true
  } catch (error) {
    if (error instanceof DomainError && error.code === 'missing-key') return false
    throw error
  }
}

/** Read the current global sync-status slot. */
export function getGlobal(domain: KbDomain): KbGlobal {
  return domain.global.get()
}

/** Durably replace the global sync-status slot. */
export async function setGlobal(domain: KbDomain, value: KbGlobal): Promise<void> {
  await domain.global.set(value)
}