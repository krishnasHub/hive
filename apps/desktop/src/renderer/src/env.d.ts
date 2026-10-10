import type { HiveApi } from '@shared/api'

declare global {
  interface Window {
    hive: HiveApi
  }
}

export {}
