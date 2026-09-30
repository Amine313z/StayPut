import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    // Each database test file boots its own Postgres (PGlite) and applies every migration.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
