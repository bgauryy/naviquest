/**
 * A module that exports `then` becomes a thenable.
 *
 * `await import(m)` hands the namespace object to the promise machinery, which
 * duck-types it: any `then` export is treated as the promise protocol and
 * called with `(resolve, reject)`. The import then resolves to whatever that
 * function passes along, or rejects — with a native function and no stack, which
 * is close to undebuggable.
 *
 * Static importers never see it, because the binding is inlined at build time.
 * So a bundle can ship green while every dynamic consumer of that module is
 * broken. This SDK dynamically imports three of its own modules and is itself
 * dynamically imported by hosts, which makes the entry namespace the one that
 * matters most: if `@naviquest/core` ever exports `then`, every host doing
 * `await import('@naviquest/core')` breaks at once.
 *
 * Cheap to assert, so it is asserted rather than remembered.
 */
import { describe, expect, it } from 'vitest';

import * as entry from '../src/index.ts';
import * as asyncSeam from '../src/async.ts';
import * as lane from '../src/retrieval/lane.ts';
import * as toolSpecs from '../src/tools/tool-specs.ts';

const namespaces = {
  // The package entry. Hosts `await import()` this.
  'src/index.ts': entry,
  // Home of the sync-or-promise helper — the module that had the defect.
  'src/async.ts': asyncSeam,
  // `index.ts` loads these three with a dynamic import.
  'src/retrieval/lane.ts': lane,
  'src/tools/tool-specs.ts': toolSpecs,
};

describe('module namespaces are not accidentally thenable', () => {
  for (const [name, ns] of Object.entries(namespaces)) {
    it(`${name} does not export a function named "then"`, () => {
      expect(typeof (ns as Record<string, unknown>).then).not.toBe('function');
    });
  }

  it('a dynamically imported module resolves to its namespace', async () => {
    // The real symptom: this rejected with `function () { [native code] }`.
    const ns = await import('../src/async.ts');
    expect(typeof ns.chain).toBe('function');
    expect(ns.chain(1, (v) => v + 1)).toBe(2);
  });

  it('chain stays synchronous for a synchronous input', () => {
    // The whole reason the helper exists: the inline lane must not be forced
    // into a promise, because construction is synchronous by contract.
    const out = asyncSeam.chain('a', (v) => `${v}b`);
    expect(out).toBe('ab');
    expect(out).not.toBeInstanceOf(Promise);
  });

  it('chain awaits an asynchronous input', async () => {
    const out = asyncSeam.chain(Promise.resolve(1), (v) => v + 1);
    expect(out).toBeInstanceOf(Promise);
    await expect(out).resolves.toBe(2);
  });
});
