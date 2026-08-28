/**
 * Auto-injection — the passive knowledge-base loop.
 *
 * On every turn's first step, the conversation text is screened against the
 * Yuque catalogue: matching tokens trigger a live body read (local catalogue
 * hit) or a cloud full-text probe (`autoInjectRemote`), and the relevant
 * document fragment is entered into the request as a plugin-sourced snapshot
 * message. The user never has to name the plugin or the document — the KB
 * acts as external memory that surfaces itself.
 *
 * Safety rails: per-session throttle (intervalMs), per-query result cache,
 * greeting/command filtering, silent failure (a broken probe never disturbs
 * the conversation), and AbortSignal cooperation.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { KbEngine } from './engine.ts'

/** Plugin identity stamped on injected messages. */
export const AUTO_PLUGIN = 'dsh-yuque-kb'
/** Section name of the injected snapshot. */
export const AUTO_SECTION = 'yuque-kb-auto'

/** Auto-injection configuration (all optional; defaults below). */
export interface AutoInjectConfig {
  /** Master switch (default true). */
  enabled?: boolean
  /** Probe the Yuque cloud search when the local catalogue misses (default true). */
  autoInjectRemote?: boolean
  /** Minimum milliseconds between auto injections in one session (default 30000). */
  intervalMs?: number
  /** Minimum user-text length that may trigger a probe (default 8). */
  minQueryChars?: number
}

/** Defaults of {@link AutoInjectConfig}. */
const DEFAULTS = { enabled: true, autoInjectRemote: true, intervalMs: 30_000, minQueryChars: 8 }

const CACHE_TTL_MS = 10 * 60_000
const MAX_SEARCH_QUERY = 200
const MAX_INJECT_CHARS = 1500

/** Greetings / short acknowledgements never trigger a probe. */
const GREETING = /^(你好|您好|hi|hello|嗨|在吗|谢谢|多谢|再见|拜拜|继续|好的|好|ok|嗯)[!！?？.。…\s]*$/iu

/** Extract search tokens from a free-form user message. */
export function extractQueryTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(/[\u4E00-\u9FFF\u3400-\u4DBF]{2,}/gu)) {
    tokens.push(match[0])
  }
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/gu)) {
    tokens.push(match[0].toLowerCase())
  }
  return [...new Set(tokens)]
}

/** Last user message text of the open turn (entered or proposed). */
function latestUserText(agent: Agent, proposed: readonly { content?: unknown }[]): string | undefined {
  for (const message of [...proposed].reverse()) {
    const content = message.content
    if (Array.isArray(content)) {
      const text = content
        .filter(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
        .map(block => (block as { text?: unknown }).text)
        .filter((part): part is string => typeof part === 'string')
        .join('')
      if (text !== undefined && text !== '') return text
    }
  }
  for (const event of [...agent.session.events].reverse()) {
    if (event.type !== 'user/message') continue
    if (event.data.source.kind === 'plugin') continue
    const content = event.data.content
    if (Array.isArray(content)) {
      const text = content
        .filter(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
        .map(block => (block as { text?: unknown }).text)
        .filter((part): part is string => typeof part === 'string')
        .join('')
      if (text !== '') return text
    }
  }
  return undefined
}

/** Render the injected fragment for one local read. */
function renderLocalInjection(record: { docId: string; title: string; repo: string; path: string; totalBlocks: number; blocks: string[] }): string {
  const location = record.path !== '' && record.path !== undefined
    ? `${record.repo}/${record.path}`
    : record.repo
  const body = record.blocks.join('\n\n').slice(0, MAX_INJECT_CHARS)
  return `[${AUTO_SECTION}] 检测到当前对话与你的语雀文档相关，已自动检索以下内容（回答时可直接引用并注明出处「语雀：《${record.title}》」）：\n来源：${location}\n\n${body}\n\n（该文档共 ${record.totalBlocks} 块，以上为相关片段；如需阅读其余部分请调用 kb_read（docId=${record.docId}）继续）`
}

/** Render the injected fragment for a cloud hit (summary-level). */
function renderRemoteInjection(hit: { title: string; repo: string; url: string; summary: string; body?: string }): string {
  const location = hit.url
  const body = hit.body !== undefined && hit.body !== ''
    ? hit.body.slice(0, MAX_INJECT_CHARS)
    : hit.summary
  return `[${AUTO_SECTION}] 云端检索到与当前对话相关的语雀文档（回答时可直接引用并注明出处「语雀：《${hit.title}》」，如需更深入引用可调用 kb_read / kb_search_remote）：\n来源：${location}\n\n${body}`
}

/** One candidate hit (docId → score) from local catalogue scans. */
interface LocalHit {
  docId: string
  title: string
  repo: string
  path: string
  score: number
}

/**
 * Try to build one auto-injection text for `query`.
 * @param engine - the kb engine (search/read/searchRemote are quota-aware).
 * @param query - the full user message text.
 * @param options - resolved auto-inject options.
 * @param signal - request cancellation.
 * @returns the injection text, or undefined when nothing relevant was found.
 */
export async function tryAutoInjection(
  engine: KbEngine,
  query: string,
  options: Required<AutoInjectConfig>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const tokens = extractQueryTokens(query)
  if (tokens.length === 0) return undefined
  // CJK 2-char shingles of every CJK token — substring matching misses
  // keyword-in-sentence queries ("的兑换码各档性价比" never matches a title).
  const grams = new Set<string>()
  for (const token of tokens) {
    for (let index = 0; index + 2 <= token.length; index++) {
      const gram = token.slice(index, index + 2)
      if (/[\u4E00-\u9FFF\u3400-\u4DBF]{2}/u.test(gram)) grams.add(gram)
    }
  }
  const probes = [...new Set([...tokens, ...grams])].slice(0, 10)

  // 1) Local catalogue (title/path), zero quota.
  const hits = new Map<string, LocalHit>()
  for (const probe of probes) {
    if (signal?.aborted === true) return undefined
    const result = engine.search(probe, 8)
    for (const item of result.items) {
      const previous = hits.get(item.docId)
      const titleHit = item.title.toLowerCase().includes(probe)
      const pathHit = item.path.toLowerCase().includes(probe)
      hits.set(item.docId, {
        docId: item.docId,
        title: item.title,
        repo: item.repo,
        path: item.path,
        score: (previous?.score ?? 0) + (titleHit ? 2 : 0) + (pathHit ? 1 : 0),
      })
    }
  }
  const best = [...hits.values()].sort((left, right) => right.score - left.score)[0]
  if (best !== undefined && best.score > 0) {
    if (signal?.aborted === true) return undefined
    try {
      const read = await engine.read(best.docId, 0, 6, signal)
      if (read.totalBlocks === 0) return undefined
      // Prefer blocks that carry the query shingles so the injected window
      // covers the relevant part of a long document, not just its head.
      const needle = new Set(grams)
      const weight = (text: string): number =>
        [...needle].filter(gram => text.includes(gram)).length
      const blocks = [...read.blocks].sort((left, right) => weight(right.text) - weight(left.text))
      return renderLocalInjection({
        docId: read.docId,
        title: read.title,
        repo: read.repo,
        path: best.path,
        totalBlocks: read.totalBlocks,
        blocks: blocks.map(block => block.text),
      })
    } catch {
      return undefined // 429 / transient: stay silent.
    }
  }

  // 2) Cloud full-text probe (opt-in, one request).
  if (!options.autoInjectRemote) return undefined
  if (signal?.aborted === true) return undefined
  try {
    const result = await engine.searchRemote({ query: query.slice(0, MAX_SEARCH_QUERY), limit: 3 }, signal)
    const top = result.items[0]
    if (top === undefined || top.docId === '') return undefined
    // Hit url may be absolute (`https://www.yuque.com/...`) or relative:
    // extract `/login/repo/slug` for a live body read.
    const pathname = (() => {
      try { return new URL(top.url).pathname } catch { return top.url }
    })()
    const match = pathname.match(/^\/([^/]+\/[^/]+)\/([^/?#]+)/)
    if (match !== null) {
      try {
        const read = await engine.readByRef(match[1]!, match[2]!, top.title, 4, signal)
        return renderRemoteInjection({
          title: read.title,
          repo: read.repo,
          url: top.url,
          summary: top.summary,
          body: read.blocks.map(block => block.text).join('\n\n'),
        })
      } catch {
        return renderRemoteInjection({ title: top.title, repo: top.repo, url: top.url, summary: top.summary })
      }
    }
    return renderRemoteInjection({ title: top.title, repo: top.repo, url: top.url, summary: top.summary })
  } catch {
    return undefined
  }
}

/** Mount the passive injection listener (disposed with `ctx`). */
export function mountAutoInject(
  ctx: Context,
  deps: { engine: KbEngine; config: () => AutoInjectConfig },
): void {
  const sessions = new Map<string, { at: number; query: string }>()
  const cache = new Map<string, { at: number; text: string }>()

  ctx.on('agent/pre-step', async (
    { agent, step, signal }: { agent: Agent; turn: number; step: number; signal: AbortSignal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted === true || step !== 1) return decision
    const cfg = { ...DEFAULTS, ...deps.config() }
    if (!cfg.enabled) return decision
    const text = latestUserText(agent, (decision as { messages?: { content?: unknown }[] }).messages ?? [])
    if (text === undefined || text.trim() === '') return decision
    const trimmed = text.trim()
    if (trimmed.length < cfg.minQueryChars || GREETING.test(trimmed)) return decision

    const now = Date.now()
    const session = sessions.get(agent.id)
    if (session !== undefined && now - session.at < cfg.intervalMs && session.query === trimmed) {
      return decision
    }
    sessions.set(agent.id, { at: now, query: trimmed })

    let injected: string | undefined
    try {
      const cached = cache.get(trimmed)
      if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
        injected = cached.text
      } else {
        injected = await tryAutoInjection(deps.engine, trimmed, cfg, signal)
        if (injected !== undefined) cache.set(trimmed, { at: now, text: injected })
      }
    } catch {
      injected = undefined
    }
    if (injected === undefined || signal.aborted) return decision

    const decisionMessages = (decision as { messages: UserMessage[] }).messages
    return {
      kind: 'enter',
      messages: [
        ...decisionMessages,
        createUserMessage({
          content: [{ type: 'text', text: injected }],
          source: { kind: 'plugin', plugin: AUTO_PLUGIN, form: 'snapshot', sections: [{ name: AUTO_SECTION, text: injected }] },
        }),
      ],
    }
  }, { prepend: true })
}