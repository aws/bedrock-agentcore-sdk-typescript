import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          include: ['src/**/__tests__/**/*.test.ts'],
          includeSource: ['src/**/*.{js,ts}'],
          name: { label: 'unit-node', color: 'green' },
          typecheck: {
            enabled: false,
          },
        },
      },
      {
        test: {
          include: ['tests_integ/**/*.test.ts'],
          name: { label: 'integ', color: 'magenta' },
          testTimeout: 30000,
          setupFiles: ['./tests_integ/setup.ts'],
          sequence: {
            concurrent: true,
          },
        },
      },
    ],
    typecheck: {
      enabled: false,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/__fixtures__/**',
        'src/**/index.ts', // Re-export files
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
        // Allow lower thresholds - app.ts needs integration tests
        perFile: true,
      },
    },
    environment: 'node',
  },
  define: {
    'import.meta.vitest': 'undefined',
  },
})
