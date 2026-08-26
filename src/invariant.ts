/**
 * Invariant companion plugin of `dsh-yuque-kb`.
 *
 * No runtime assertions: the plugin owns no cross-package state whose
 * relationship a loader-time invariant could observe. The catalogue lockstep
 * (docs table ⇔ repos table, updated within one sync) and the
 * token-precedence rule (config secret → domain global runtime credential)
 * are exercised by the composition tests.
 */

/** Provides no assertions — see module docs. */
export function apply(): void {}