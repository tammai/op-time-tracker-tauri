import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
import { fileURLToPath, URL } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { getIcons } from '@iconify/utils'

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

/**
 * `virtual:lucide-subset` — the lucide icons this app actually renders, and
 * nothing else.
 *
 * The whole collection is ~1,600 icons and about half a megabyte of the bundle;
 * this app draws around ninety. The subset is computed by **scanning at build
 * time** rather than from a checked-in list, because a hand-maintained list goes
 * stale silently: the symptom is one blank icon in one dialog, which no test
 * catches and nobody notices until a user does.
 *
 * Two sources, and the second is the one that is easy to forget:
 *
 * 1. this app's own source — every name appears as a static `i-lucide-…`
 *    literal, so a regex sees all of them;
 * 2. **Nuxt UI's own defaults** — a select's chevron, a modal's close button, a
 *    toast's alert glyph. Those names live in the library's compiled theme, not
 *    in this repo, and omitting them empties half the chrome.
 *
 * Icons resolve from the registered collection only, so a name that escapes the
 * scan renders blank rather than falling back to the network (the CSP blocks
 * that anyway, deliberately). Hence the floor check below: a scan that comes
 * back implausibly small fails the build instead of shipping a hollow UI.
 */
function lucideSubset(): Plugin {
  const SPECIFIER = 'virtual:lucide-subset'
  const RESOLVED = '\0' + SPECIFIER
  const ICON_NAME = /i-lucide-([a-z0-9]+(?:-[a-z0-9]+)*)/g
  const SCANNED_EXTENSIONS = new Set(['.vue', '.ts', '.js', '.mjs'])
  /** Below this, assume the scan broke rather than that the app shrank. */
  const MINIMUM_EXPECTED = 40

  const root = fileURLToPath(new URL('.', import.meta.url))

  function collectFrom(dir: string, into: Set<string>): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        collectFrom(path, into)
        continue
      }
      if (!SCANNED_EXTENSIONS.has(extname(entry))) continue
      const source = readFileSync(path, 'utf8')
      for (const [, name] of source.matchAll(ICON_NAME)) into.add(name)
    }
  }

  let cached: string | null = null

  return {
    name: 'lucide-subset',
    resolveId(id) {
      return id === SPECIFIER ? RESOLVED : null
    },
    load(id) {
      if (id !== RESOLVED) return null
      if (cached !== null) return cached

      const names = new Set<string>()
      collectFrom(join(root, 'src'), names)
      // The library's compiled theme, wherever its hashed chunk lives this
      // version — globbing the directory rather than naming the file, which
      // changes with every release.
      collectFrom(join(root, 'node_modules/@nuxt/ui/dist/shared'), names)

      if (names.size < MINIMUM_EXPECTED) {
        throw new Error(
          `lucide-subset: found only ${names.size} icon names (expected at least ` +
            `${MINIMUM_EXPECTED}). The scan is probably broken — refusing to build ` +
            `an app with missing icons.`
        )
      }

      const collection = JSON.parse(
        readFileSync(join(root, 'node_modules/@iconify-json/lucide/icons.json'), 'utf8')
      )
      const subset = getIcons(collection, [...names])
      if (!subset) {
        throw new Error('lucide-subset: could not slice the lucide collection.')
      }

      // A name resolves either directly or through an alias — lucide renames
      // icons and keeps the old spelling as an alias (`alert-triangle` is now
      // `triangle-alert`), and this app uses three of those. Checking only
      // `icons` reported them as missing on every build, which is how a warning
      // teaches people to ignore warnings.
      const aliases = subset.aliases ?? {}
      const missing = [...names].filter(
        (name) => !(name in subset.icons) && !(name in aliases)
      )
      if (missing.length > 0) {
        // Not fatal: the blank icon is the visible symptom, and failing the
        // build over one glyph would be worse than shipping it.
        this.warn(
          `lucide-subset: ${missing.length} name(s) not found in lucide: ${missing.join(', ')}`
        )
      }

      const kept = Object.keys(subset.icons).length
      const total = Object.keys(collection.icons).length
      this.info?.(
        `lucide-subset: bundling ${kept} of ${total} icons ` +
          `(${Object.keys(aliases).length} aliases, ${names.size} names scanned)`
      )

      cached = `export default ${JSON.stringify(subset)}`
      return cached
    }
  }
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
    lucideSubset(),
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
