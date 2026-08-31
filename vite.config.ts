import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

/**
 * Vite config for the webview half. One config, not three: with the main and
 * preload processes gone (they are Rust now), there is a single bundle.
 *
 * `package.json` stays the single source of truth for the version and author
 * shown in the settings footer (`src/utils/app-info.ts`), read here and injected
 * as `define` constants so the frontend needs no round trip for static build
 * metadata. Mirrored in `vitest.config.ts`.
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')
) as { version: string; author?: string | { name?: string; email?: string } }

const appInfoDefine = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __APP_AUTHOR__: JSON.stringify(
    typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? '')
  ),
  __APP_AUTHOR_EMAIL__: JSON.stringify(
    typeof pkg.author === 'string' ? '' : (pkg.author?.email ?? '')
  )
}

const alias = {
  '@renderer': fileURLToPath(new URL('./src', import.meta.url)),
  // The bridge is the preload script's successor, and keeping the old specifier
  // is what let ~20 frontend modules come across without an import rewrite.
  '@opentracker/preload': fileURLToPath(new URL('./src/bridge/index.ts', import.meta.url)),
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '~~': fileURLToPath(new URL('.', import.meta.url))
}

export default defineConfig({
  define: appInfoDefine,
  resolve: { alias },
  plugins: [
    vue(),
    // Nuxt UI v4 as a Vue plugin (non-Nuxt). `router: false` because this is a
    // single-window app with no vue-router. The `ui.colors` block mirrors
    // `app.config.ts`, which is kept as the design-handoff source of truth —
    // there is no Nuxt runtime here to read it.
    ui({
      root: fileURLToPath(new URL('.', import.meta.url)),
      router: false,
      ui: {
        colors: {
          primary: 'blue',
          neutral: 'slate'
        }
      }
    })
  ],
  // Tauri expects a fixed port it can point the webview at, and a failure is
  // better than silently serving on another one the app will not load.
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // `cargo` owns this tree; watching it would restart Vite on every build
      // artifact.
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The bundle is loaded from the app's own asset protocol, not a browser, so
    // a source map is a debugging aid with no download cost to weigh it against.
    sourcemap: true
  }
})
