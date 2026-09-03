/**
 * Globals this SDK puts on `window` — now exactly one.
 *
 * `window.naviquest` is the ONE documented integration point. A component that
 * owns a closed shadow root calls `registerRegion(this.shadowRoot)` from
 * `connectedCallback`, because page JavaScript cannot pierce a closed root and
 * only the component that created it can hand it in.
 *
 * Everything else that used to be declared here was a HARNESS SEAM —
 * `__wfInternals`, `__createNaviquest`, `__wf`, `__refs`, an `axe` slot and eight
 * more. They existed so the evaluation scripts drove the code the SDK ships
 * rather than a reimplementation of it, and they were kept in a separate block
 * precisely so a test seam could not become public API by accident. The harness
 * has been removed from this repository, so they are gone with it: a global with
 * no caller is not a seam, it is surface area.
 *
 * The consequence worth stating: the SDK's internals are no longer reachable
 * from outside its module graph. A host uses the object `createNaviquest()`
 * returns, and `window.naviquest` for the closed-shadow-root case.
 */
import type { NaviquestApi } from './index.ts';

/** The instance `createNaviquest()` resolves to. Public tools are always promises. */
export type Naviquest = NaviquestApi;

declare global {
  interface Window {
    /** The documented integration point for component authors. */
    naviquest?: Naviquest;
  }
}
