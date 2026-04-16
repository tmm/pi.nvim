import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
  },
  lint: {
    ignorePatterns: ['dist/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  staged: {
    '*.{js,mjs,cjs,ts,mts,cts,tsx,json,md}': 'vp check --fix',
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
})
