/**
 * dsh-yuque-kb — host half. Mounts the P4 host capability over the P2/P3
 * layers: the four agent tools (`kb_sync` / `kb_search` / `kb_read` /
 * `kb_search_remote`), the system-prompt announcement (order 150), the
 * `/api/dsh-yuque-kb` route family (loopback-fenced), the settings namespace
 * (`dsh-yuque-kb`), and the optional startup sync. See `.ref/开发计划-SSOT.md`
 * (P4) for the contracts.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { createEngine, type KbEngine } from './engine.ts'
import { mountAutoInject } from './auto-inject.ts'
import { openDomain, type KbDomain } from './storage/domain.ts'
import { makeRoutes } from './routes.ts'
import { kbReadTool, kbSearchRemoteTool, kbSearchTool, kbSyncTool } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'yuque-kb'

/** Services required before the yuque-kb surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/**
 * Settings namespace of the knowledge-base capability — the section the web
 * settings surface edits. Spelled here rather than imported by consumers:
 * the browser half spells the same value and must not depend on host code.
 */
export const KB_NS = settingsNamespace('dsh-yuque-kb')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
  /** When true (default), a system-prompt section announces the plugin to every agent. */
  announceToAgent?: boolean
  /** Run an incremental sync at startup (default off; only when a token is configured). */
  syncOnStartup?: boolean
  /** Yuque personal token (`X-Auth-Token`); secret, never echoed back. */
  yuqueToken?: string
  /** Client-side request rate cap (Yuque compliance; default 3 req/s). */
  rateLimitPerSec?: number
  /** Default hit count of `kb_search` (1..20; default 8). */
  searchLimit?: number
  /** Body chunk ceiling in code points for `kb_read` paging (default 512). */
  blockCharLimit?: number
  /** Timeout budget for remote-fetch tools (`kb_read`, `kb_search_remote`; ms). */
  timeoutMs?: number
  /** Passively probe the Yuque catalogue on conversation turns and inject
   * relevant document fragments (default true). */
  autoInject?: boolean
  /** Let the passive probe fall back to the Yuque cloud search when the local
   * catalogue misses (default true; one request per probe). */
  autoInjectRemote?: boolean
  /** Minimum milliseconds between passive injections in one session (default 30000). */
  autoInjectIntervalMs?: number
  /** Minimum user-text length that may trigger a passive probe (default 8). */
  autoInjectMinQueryChars?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  syncOnStartup: z.boolean().default(false),
  yuqueToken: z.string().role('secret').default(''),
  rateLimitPerSec: z.number().default(3),
  searchLimit: z.number().default(8),
  blockCharLimit: z.number().default(512),
  timeoutMs: z.number().default(30000),
  autoInject: z.boolean().default(true),
  autoInjectRemote: z.boolean().default(true),
  autoInjectIntervalMs: z.number().default(30000),
  autoInjectMinQueryChars: z.number().default(8),
})

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, triggers, limits. */
export const KB_GUIDANCE = '本机已安装 dsh-yuque-kb 插件（语雀知识库——你的个人语雀文档构成的外部记忆）：①被动注入：对话内容与你的语雀文档相关时，插件会本回合自动检索并注入相关文档片段（消息标注 [yuque-kb-auto]），无需点名插件或文档；对注入内容应直接使用并标注出处「语雀：《标题》」。②显式工具：kb_search 按标题/路径检索本地目录（零额度）、kb_read 在线分块读正文、kb_search_remote 语雀云端全文搜索（消耗额度）、kb_sync 增量同步目录。限制：本地只存目录快照；在线检索消耗语雀 API 额度；开关与禁用范围在设置「语雀知识库」里配置。'

/** Schema defaults re-read by hand-built test contexts (the loader applies them). */
const DEFAULTS = {
  enabled: true,
  announceToAgent: true,
  syncOnStartup: false,
  yuqueToken: '',
  rateLimitPerSec: 3,
  searchLimit: 8,
  blockCharLimit: 512,
  timeoutMs: 30_000,
  autoInject: true,
  autoInjectRemote: true,
  autoInjectIntervalMs: 30_000,
  autoInjectMinQueryChars: 8,
}

/** The effective live config (settings section first, schema defaults last). */
type ResolvedConfig = Required<Config>

function resolveConfig(value: Config): ResolvedConfig {
  return {
    enabled: value.enabled ?? DEFAULTS.enabled,
    announceToAgent: value.announceToAgent ?? DEFAULTS.announceToAgent,
    syncOnStartup: value.syncOnStartup ?? DEFAULTS.syncOnStartup,
    yuqueToken: value.yuqueToken ?? DEFAULTS.yuqueToken,
    rateLimitPerSec: value.rateLimitPerSec ?? DEFAULTS.rateLimitPerSec,
    searchLimit: value.searchLimit ?? DEFAULTS.searchLimit,
    blockCharLimit: value.blockCharLimit ?? DEFAULTS.blockCharLimit,
    timeoutMs: value.timeoutMs ?? DEFAULTS.timeoutMs,
    autoInject: value.autoInject ?? DEFAULTS.autoInject,
    autoInjectRemote: value.autoInjectRemote ?? DEFAULTS.autoInjectRemote,
    autoInjectIntervalMs: value.autoInjectIntervalMs ?? DEFAULTS.autoInjectIntervalMs,
    autoInjectMinQueryChars: value.autoInjectMinQueryChars ?? DEFAULTS.autoInjectMinQueryChars,
  }
}

/**
 * Mount the plugin.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): ResolvedConfig => resolveConfig(current())

  const domain: KbDomain = await openDomain(ctx)

  const engine: KbEngine = createEngine({
    domain,
    config: () => ({
      yuqueToken: resolve().yuqueToken,
      rateLimitPerSec: resolve().rateLimitPerSec,
      searchLimit: resolve().searchLimit,
      blockCharLimit: resolve().blockCharLimit,
      timeoutMs: resolve().timeoutMs,
    }),
  })

  // The passive knowledge loop: screen every turn's first step against the
  // catalogue and inject relevant document fragments (see src/auto-inject.ts).
  mountAutoInject(ctx, {
    engine,
    config: () => ({
      enabled: resolve().autoInject,
      autoInjectRemote: resolve().autoInjectRemote,
      intervalMs: resolve().autoInjectIntervalMs,
      minQueryChars: resolve().autoInjectMinQueryChars,
    }),
  })

  // Register (or drop) every surface to match the current source. Each group
  // is kept under one disposer: re-registering first tears the old one down
  // so duplicate-name registrations never throw (dsh-ssh sync pattern).
  let disposeSection: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeTools: (() => void) | undefined
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    const value = resolve()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-yuque-kb',
        order: SECTION_ORDER,
        text: KB_GUIDANCE,
      })
    }
    const routes: WebRoute[] = makeRoutes({ ctx, engine, ns: KB_NS })
    const tools = [
      kbSyncTool(ctx, engine),
      kbSearchTool(engine, () => resolve()),
      kbReadTool(engine, () => resolve()),
      kbSearchRemoteTool(engine, () => resolve()),
    ]
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'yuque-kb: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'yuque-kb: tools',
    )
  }

  installSettingsSection(ctx, KB_NS, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()

  // Optional startup sync — only when enabled, a token exists, and the
  // feature is switched on. Runs detached (failures log, never throw).
  if (resolve().syncOnStartup && resolve().enabled && engine.resolveToken() !== undefined) {
    void engine.sync().catch(error => {
      ctx.logger.warn('[yuque-kb] startup sync failed: %s', error instanceof Error ? error.message : String(error))
    })
  }
}