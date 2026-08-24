import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.spec.ts', 'src/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      include: ['src/services/**/*.ts', 'src/domain/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
