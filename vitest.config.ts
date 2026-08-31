import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

// Mirrors the `define` block in `vite.config.ts` so `@renderer/utils/app-info`
// resolves the same build constants under test as it does in the app.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')
) as { version: string; author?: string | { name?: string; email?: string } }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_AUTHOR__: JSON.stringify(
      typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? '')
    ),
    __APP_AUTHOR_EMAIL__: JSON.stringify(
      typeof pkg.author === 'string' ? '' : (pkg.author?.email ?? '')
    )
  },
  test: {
    // The frontend half only. Everything that used to live under `tests/main/`
    // is Rust now and runs under `cargo test` — see `pnpm test:rust`.
    include: ['tests/**/*.test.ts'],
    globals: false,
    passWithNoTests: true
  },
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src', import.meta.url)),
      '@opentracker/preload': fileURLToPath(new URL('./src/bridge/index.ts', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '~~': fileURLToPath(new URL('.', import.meta.url))
    }
  }
})
