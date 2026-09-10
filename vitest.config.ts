import { defineConfig } from 'vitest/config';

/**
 * Node-side tests only, for now. A second `web` project with `environment: 'jsdom'` gets
 * added at T19, when there are actually React components worth testing — installing jsdom
 * and Testing Library before then would be dead weight.
 *
 * No mocking library and no snapshots, deliberately. Dependencies arrive by injection
 * through `TurnDeps`, so the rule "if it needs vi.mock, the seam is wrong" stays
 * enforceable in review. Tests import { test, expect } and otherwise read like plain
 * assertions.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Fail rather than silently pass when a glob matches nothing — a renamed directory
    // otherwise turns a whole suite into a green no-op.
    passWithNoTests: false,
  },
});
