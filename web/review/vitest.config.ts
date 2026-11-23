import { defineConfig } from 'vitest/config';

// Kept apart from the normal test suite: these tests document known defects
// with expected-failure assertions.
export default defineConfig({
  test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'], include: ['review/*.test.{ts,tsx}'] },
});
