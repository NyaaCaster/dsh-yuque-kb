/**
 * Invariant companion plugin of `dsh-yuque-kb`.
 *
 * No runtime assertions: the plugin owns no cross-package state whose
 * relationship a loader-time invariant could observe. The domain/FTS write
 * lockstep (docs table record ⇔ index rows) is exercised by the composition
 * tests; the token-precedence rule (config secret → domain global runtime
 * credential) is covered by the route tests.
 */

/** Provides no assertions — see module docs. */
export function apply(): void {}