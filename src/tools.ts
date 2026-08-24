/**
 * Agent tools: `kb_sync` / `kb_search` / `kb_read` / `kb_search_remote` —
 * the model-facing surface of the yuque-kb capability (SSOT §3.1). Search
 * results render with the `search` UI intent (`presentResult` → matches
 * grouped by repo/title); remote-fetch surfaces declare `timeoutMs` and
 * forward `exec.signal` into the transport.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { SearchResultView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { KbEngine, KbEngineConfig, ReadResult, SyncResult } from './engine.ts'

/**
 * Minimal surface of the optional background-job registry
 * (`@deepseek-ai/dsh-jobs`). Kept local (no type dependency on the host
 * package): `ctx.get('jobs')` resolves the live registry when a deployment
 * mounts one, `undefined` otherwise — see the tool-bash pattern.
 */
interface KbJobRegistry {
  start(spec: {
    kind: string
    label: string
    owner?: object
    run(): {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
    }
  }): string
}

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Render a foreground sync outcome for the model. */
export function renderSyncResult(value: SyncResult): string {
  const header = `synced ${value.synced} docs (added ${value.added}, updated ${value.updated}, removed ${value.removed})`
  const rate = value.rateRemaining === null ? '' : `; rate remaining: ${value.rateRemaining}`
  const lines = [header + rate]
  if (value.errors.length > 0) {
    lines.push(`errors: ${value.errors.length}`)
    for (const error of value.errors.slice(0, 8)) {
      const where = [error.repo, error.doc].filter(part => part !== undefined).join('/')
      lines.push(`- ${where}: ${error.message}`)
    }
  }
  return lines.join('\n')
}

/** One kb_search hit line. */
function renderHit(item: { title: string; path: string; repo: string; updatedAt: number; snippet: string }, index: number): string {
  const location = item.path !== '' ? `${item.repo}/${item.path}` : item.repo
  const when = item.updatedAt > 0 ? new Date(item.updatedAt).toISOString().slice(0, 10) : 'unknown'
  return `${index + 1}. [${item.title}] (${location}, updated ${when})\n   ${item.snippet}`
}

/** `kb_sync`: foreground + background (ctx.jobs, tool-bash pattern). */
export function kbSyncTool(ctx: Context, engine: KbEngine): ToolDefinition {
  return defineTool({
    name: 'kb_sync',
    description: 'Sync the local Yuque knowledge-base index with the remote (incremental: only changed docs are re-fetched). '
      + 'Run in the background for large libraries; the call returns a job id immediately (collect with job_output, stop with job_kill). '
      + 'Use when the user asks to sync/update/refresh the knowledge base, or before the first kb_search.',
    parameters: {
      repos: {
        type: 'array' as const,
        items: { type: 'string' },
        description: 'Restrict sync to these repo namespaces (e.g. `login/slug`); default: every accessible repo.',
      },
      run_in_background: {
        type: 'boolean' as const,
        description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill).',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' as const },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' as const },
              synced: { type: 'integer', required: true },
              added: { type: 'integer', required: true },
              updated: { type: 'integer', required: true },
              removed: { type: 'integer', required: true },
              errors: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    repo: { type: 'string' },
                    doc: { type: 'string' },
                    message: { type: 'string', required: true },
                  },
                },
              },
              rateRemaining: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
            },
          },
        ],
      },
      render: (_args, value) => text(value.kind === 'background'
        ? `started background job ${value.jobId}`
        : renderSyncResult(value)),
    },
    presentCall: (args) => {
      const repos = typeof args === 'object' && args !== null
        ? (args as { repos?: string[] }).repos
        : undefined
      const title = repos !== undefined && repos.length > 0
        ? `kb_sync (${repos.join(', ')})`
        : 'kb_sync'
      return { card: 'generic', title, kind: 'execute' }
    },
    async execute(args: { repos?: string[]; run_in_background?: boolean }, exec) {
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs') as KbJobRegistry | undefined
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        // Post-id cancellation belongs to the job (exec.signal only gates waits).
        const controller = new AbortController()
        const id = jobs.start({
          kind: 'kb-sync',
          label: args.repos !== undefined && args.repos.length > 0
            ? `sync yuque kb (${args.repos.join(', ')})`
            : 'sync yuque kb',
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => {
            const done = engine.sync({ repos: args.repos, signal: controller.signal })
              .then(result => ({
                status: 'completed' as const,
                detail: `synced ${result.synced} docs, ${result.errors.length} errors`,
                output: renderSyncResult(result),
              }))
              .catch(error => ({
                status: 'failed' as const,
                detail: error instanceof Error ? error.message : String(error),
                output: '',
              }))
            return { cancel: () => controller.abort(), done }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }
      const result = await engine.sync({ repos: args.repos, signal: exec.signal })
      return { kind: 'foreground' as const, ...result }
    },
  })
}

/** `kb_search`: local FTS5 over enabled docs (enabled-filtered, honest truncation). */
export function kbSearchTool(engine: KbEngine, config: () => KbEngineConfig): ToolDefinition {
  return defineTool({
    name: 'kb_search',
    description: 'Search the locally synced Yuque knowledge base (offline FTS index — no API quota consumed). '
      + 'CJK: terms of 3+ characters match substrings; shorter terms match as substrings too. '
      + 'Returns hits with title, path, update date and a snippet. '
      + 'Use when the user asks about content that may live in a synced Yuque knowledge base; if nothing matches, try kb_search_remote (cloud).',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query (keywords).' },
      limit: { type: 'integer', description: 'Max hits (1..20; default 8).' },
      repo: { type: 'string', description: 'Restrict to one repo namespace (e.g. `login/slug`).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                docId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                path: { type: 'string', required: true },
                repo: { type: 'string', required: true },
                updatedAt: { type: 'integer', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => text(renderSearchResult(value)),
      presentationMeta: (_args, value) => ({
        total: value.total,
        truncated: value.truncated,
        items: value.items.map(item => ({
          docId: item.docId,
          title: item.title,
          path: item.path,
          repo: item.repo,
          updatedAt: item.updatedAt,
        })),
      }),
    },
    presentCall: (args) => {
      const query = typeof args === 'object' && args !== null
        ? String((args as { query?: unknown }).query ?? '')
        : ''
      return { card: 'generic', title: `kb_search: ${query}`, kind: 'search' }
    },
    presentResult: (_args, result): SearchResultView => {
      const value = result.meta as { total: number; truncated: boolean; items: Array<{ title: string; repo: string; path: string; snippet: string }> } | undefined
      if (value === undefined) return { card: 'search', shape: 'paths', paths: [], truncated: false, total: 0 }
      return {
        card: 'search',
        shape: 'matches',
        files: value.items.map(item => {
          const location = item.path !== '' ? `${item.repo}/${item.path}` : item.repo
          const matches = [{ lineNumber: 1, line: item.snippet }]
          return { path: `${item.title} — ${location}`, matches }
        }),
        truncated: value.truncated,
        total: value.total,
      }
    },
    async execute(args: { query: string; limit?: number; repo?: string }) {
      return engine.search(args.query, args.limit, args.repo)
    },
  })
}

/** Render kb_search / kb_search_remote hit lists. */
function renderSearchResult(value: { total: number; truncated: boolean; items: Array<{ title: string; path: string; repo: string; updatedAt: number; snippet: string }> }): string {
  if (value.items.length === 0) return `no hits (total ${value.total})`
  const lines = [`${value.total} hits${value.truncated ? ' (truncated)' : ''}:`]
  value.items.forEach((item, index) => lines.push(renderHit(item, index)))
  return lines.join('\n')
}

/** `kb_read`: block-paged body read; live fetch fallback for not-yet-synced docs. */
export function kbReadTool(engine: KbEngine, config: () => KbEngineConfig): ToolDefinition {
  return defineTool({
    name: 'kb_read',
    description: 'Read the body of one Yuque knowledge-base doc in blocks (from the local index; a doc that is not synced yet is fetched live from Yuque, consuming API quota). '
      + 'Read in windows with startBlock/maxBlocks and continue with nextCursor. docId comes from kb_search / kb_search_remote / the 知识库 tree.',
    parameters: {
      docId: { type: 'string', required: true, description: 'The doc id from kb_search / kb_search_remote / the 知识库 tree.' },
      startBlock: { type: 'integer', description: 'First block to read (0-based; default 0).' },
      maxBlocks: { type: 'integer', description: 'Max blocks to return (1..50; default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          docId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          repo: { type: 'string', required: true },
          totalBlocks: { type: 'integer', required: true },
          startBlock: { type: 'integer', required: true },
          nextCursor: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          blocks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: ReadResult) => text(renderReadResult(value)),
    },
    presentCall: (args) => {
      const docId = typeof args === 'object' && args !== null
        ? String((args as { docId?: unknown }).docId ?? '')
        : ''
      return { card: 'generic', title: `kb_read: ${docId}`, kind: 'read' }
    },
    timeoutMs: config().timeoutMs,
    async execute(args: { docId: string; startBlock?: number; maxBlocks?: number }, exec) {
      return engine.read(args.docId, args.startBlock, args.maxBlocks, exec.signal)
    },
  })
}

/** Render a kb_read window for the model. */
export function renderReadResult(value: ReadResult): string {
  const lines = [`# ${value.title} (repo ${value.repo})`, `blocks ${value.startBlock + 1}–${value.startBlock + value.blocks.length} of ${value.totalBlocks}`]
  value.blocks.forEach((block, index) => {
    lines.push(`\n--- block ${value.startBlock + index + 1} [${block.type}] ---\n${block.text}`)
  })
  if (value.nextCursor !== null) {
    lines.push(`\n(more: nextCursor ${value.nextCursor})`)
  }
  return lines.join('\n')
}

/** `kb_search_remote`: live Yuque cloud search (docs; `<em>` stripped). */
export function kbSearchRemoteTool(engine: KbEngine, config: () => KbEngineConfig): ToolDefinition {
  return defineTool({
    name: 'kb_search_remote',
    description: 'Search Yuque in the cloud (live API; consumes Yuque API quota, not the local index). '
      + 'Use when kb_search misses or when the user asks for content that may not be synced yet. '
      + 'Default scope: this account\'s own repos (personal + accessible teams). '
      + 'An explicit scope is passed through verbatim (a repo namespace such as `login/slug`, or a team login).',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query (up to 200 characters).' },
      scope: { type: 'string', description: 'Restrict to one repo namespace (`login/slug`) or a team login; default: this account\'s repos.' },
      limit: { type: 'integer', description: 'Max hits (1..20; default 10).' },
      strict: { type: 'boolean', description: 'Pass strict matching to Yuque (exact-term behaviour).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                docId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                repo: { type: 'string', required: true },
                url: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => text(renderRemoteResult(value)),
    },
    presentCall: (args) => {
      const query = typeof args === 'object' && args !== null
        ? String((args as { query?: unknown }).query ?? '')
        : ''
      return { card: 'generic', title: `kb_search_remote: ${query}`, kind: 'search' }
    },
    timeoutMs: config().timeoutMs,
    async execute(args: { query: string; scope?: string; limit?: number; strict?: boolean }, exec) {
      return engine.searchRemote(args, exec.signal)
    },
  })
}

/** Render remote hits. */
function renderRemoteResult(value: { total: number; items: Array<{ title: string; repo: string; url: string; summary: string }> }): string {
  if (value.items.length === 0) return `no cloud hits (total ${value.total})`
  const lines = [`cloud search: ${value.total} hits:`]
  value.items.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.title}] (${item.repo || 'unknown repo'})`)
    lines.push(`   ${item.url}`)
    if (item.summary !== '') lines.push(`   ${item.summary}`)
  })
  return lines.join('\n')
}