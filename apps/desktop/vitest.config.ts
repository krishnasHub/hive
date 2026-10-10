import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core') } },
  test: { include: ['src/core/__tests__/**/*.test.ts'] }
})
