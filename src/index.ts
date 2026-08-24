/**
 * dsh-yuque-kb — host half entry (P1 skeleton).
 *
 * Capabilities land in later phases per `.ref/开发计划-SSOT.md`:
 *   P2 Yuque adapter · P3 local storage + FTS5 index · P4 agent tools
 *   (kb_sync / kb_search / kb_read / kb_search_remote), system-prompt
 *   announcement, /api/dsh-yuque-kb routes, settings schema.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'

/** Stable cordis plugin name. */
export const name = 'yuque-kb'

/** Plugin config validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
  /** When true (default), a system-prompt section announces the plugin to every agent. */
  announceToAgent?: boolean
  /** Run an incremental sync at startup (default off). */
  syncOnStartup?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  syncOnStartup: z.boolean().default(false),
})

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(_ctx: Context, _config: Config): void {
  // P1 skeleton: nothing registered yet.
}