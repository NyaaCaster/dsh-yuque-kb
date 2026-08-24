/**
 * dsh-yuque-kb — browser-half entry (P1 skeleton).
 *
 * The dedicated 设置 → 知识库 settings section (token, connection test, sync
 * status, tree toggles) lands in P5 via the `settings.section` slot.
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject: readonly string[] = []

/**
 * Mount the browser half.
 * @param _ctx - client root context.
 */
export function apply(_ctx: ClientContext): void {
  // P1 skeleton: nothing registered yet.
}