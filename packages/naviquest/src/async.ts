/**
 * The synchronous-or-promise seam, in a leaf module so it costs nothing to hold.
 *
 * This lived in `lane.ts` because the lane is what makes a call asynchronous.
 * But `index.ts` routes the whole construction and reindex path through `chain()`,
 * so importing it from `lane.ts` dragged the entire retrieval subtree — bm25,
 * lexical-index, ranking, exact — into the eager closure that every page pays
 * for, to reach four lines that touch none of it. Measured: 2,472 gzip bytes of
 * eager bundle for a type and one branch.
 *
 * Splitting it out lets `lane.ts` load with the answer engine instead, which is
 * the first moment anything can actually query an index.
 */

/** A lane answers synchronously (inline) or asynchronously (worker). One type,
 *  so the two cannot drift apart in shape any more than they can in ranking. */
export type Awaitable<T> = T | Promise<T>;

/**
 * Resolve whatever a lane returned, without forcing a promise on the inline path.
 *
 * NOT named `then`, which is what it was called while it lived in `lane.ts`.
 * A module that exports `then` makes its own namespace object a thenable, so
 * `await import('./async.ts')` hands the namespace to the promise machinery,
 * which calls `namespace.then(resolve, reject)` — this function then sees a bare
 * `resolve` with no `.then` of its own and calls `reject(resolve)`. The module
 * rejects with a native function and no stack. Static importers never notice
 * because the binding is inlined, so the shipped bundle was fine and every
 * dynamic consumer was not.
 *
 * That is not hypothetical here: `index.ts` loads the lane with
 * `import('./retrieval/lane.ts').then(...)`, so had `then` stayed in `lane.ts`
 * when the lane went lazy, the entire retrieval lane would have rejected on
 * every page. Keep this name free of `then`.
 */
export function chain<T, R>(v: Awaitable<T>, f: (value: T) => Awaitable<R>): Awaitable<R> {
  return v && typeof (v as Promise<T>).then === 'function'
    ? (v as Promise<T>).then(f)
    : f(v as T);
}
