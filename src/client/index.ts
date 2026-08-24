/**
 * dsh-yuque-kb — browser-half entry.
 *
 * Registers the dedicated 设置 → 知识库 settings section (settings.section)
 * with the token/test/sync-status/tree surface. Failure policy: mounting
 * problems are logged, never thrown — the web shell fails the whole boot
 * when a plugin apply throws.
 *
 * Export discipline: the /client surface carries what cordis loading needs
 * plus types only — no other value exports.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createKbApi } from './api.ts'
import type { KbApi } from './api.ts'
import { en, zh, type YuqueKbKey } from './locales.ts'
import { YuqueKbSection } from './section/YuqueKbSection.tsx'
import type { YuqueKbSectionInjected } from './section/YuqueKbSection.tsx'

/** Locale namespace this plugin owns. */
const NS = 'dsh-yuque-kb'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-yuque-kb surface copy. */
    'dsh-yuque-kb': YuqueKbKey
  }
}

/** Required services (fiber inject — the slot declaration arrives later via slots.inject). */
export const inject = ['slots', 'locale']

/** Type-only surface (no value exports beyond the plugin contract). */
export type { YuqueKbKey } from './locales.ts'
export type { KbApi } from './api.ts'
export type {
  DocNode,
  RepoNode,
  StatusPayload,
  SyncProgress,
  SyncResult,
  TeamNode,
  TestResult,
  ToggleRequest,
  TokenWriteRequest,
  TreePayload,
  YuqueUserInfo,
} from './types.ts'
export type { YuqueKbSectionInjected, YuqueKbSectionProps } from './section/YuqueKbSection.tsx'

/**
 * Register the 知识库 settings section once the `settings.section`
 * declaration is on the ledger.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-yuque-kb: copy dictionaries')

  const t = ctx.locale.bind(NS) as (key: keyof YuqueKbKey, params?: Record<string, string | number>) => string

  // API client is stateless; one instance per injected face.
  const api = createKbApi()

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'yuque-kb',
    order: 15,
    label: () => t('nav'),
    inject: (): YuqueKbSectionInjected => ({ api, t }),
  }, YuqueKbSection))
}