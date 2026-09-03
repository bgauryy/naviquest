import { defineConfig } from 'vitest/config';

/**
 * Vitest covers ONE thing `yarn eval` cannot: the failure and timing paths of
 * the lifecycle.
 *
 * `yarn eval` is still the gate, and it is the better tool for everything it
 * covers — it drives real Chrome, so projection, ranking, budgets and the tool
 * contracts are measured against a real accessibility tree rather than a
 * simulation. What it cannot do is make a dynamic `import()` fail, make a
 * retrieval worker crash, or land two rebuilds in the same tick on purpose.
 * Those are exactly the paths where a fail-open SDK either degrades honestly or
 * lies, and they were unreachable by any existing sensor.
 *
 * So the split is deliberate: behaviour lives in `yarn eval`, and `yarn test`
 * owns induced failure. A test here that could have been an eval check belongs
 * in `yarn eval` instead.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['packages/*/test/**/*.test.ts'],
    // The SDK reads `document` at construction; a shared document between test
    // files would let one test's DOM leak into another's projection.
    isolate: true,
  },
});
