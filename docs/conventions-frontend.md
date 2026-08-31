# Frontend conventions

Applies to `src/**` — the webview half.

## Naming

- Components: PascalCase (`WorkPackageCard.vue`)
- Composables: camelCase with a `use` prefix (`useWorkPackages.ts`)
- Pinia stores: camelCase with a `Store` suffix (`useUiStore.ts`)
- Types and interfaces: PascalCase

## State

- Global client state: Pinia stores (`src/stores/`)
- Server data: Pinia Colada queries (`useQuery`, `useMutation`)
- Local UI state: a composable, or a `ref` in the component

## Server state: Pinia Colada

- Server data goes through Colada query/mutation composables only. Client state
  (UI, filters, drafts) goes in Pinia stores. **Never wrap `useQuery` /
  `useMutation` inside a Pinia store** — Colada's cache already lives in Pinia, so
  wrapping duplicates state and breaks lifecycle tracking.
- One file per domain: `src/composables/queries/<domain>.ts`. Define query
  options with `defineQueryOptions()`, grouped in a per-domain object. Keys are
  defined once there, never hand-written inline in a component. Format:
  `['<domain>', '<scope>', ...params]`.
- Mutations colocate with their domain as `use<Action><Domain>()`. Cache
  invalidation happens inside the mutation composable via `useQueryCache()` —
  never in a component.
- **Components consume composables, not the bridge.** No component calls
  `window.openproject.*` directly; going through the query layer is what keeps
  cache and invalidation wired.
- Use `defineQuery()` when several components on one view share a query.
- Resource types are imported from `@opentracker/preload` (i.e. `src/bridge`),
  and the query layer is the only place that happens.

## Components

- No business logic in a component — move it to a composable or a store.
- Props typed with `defineProps<{}>()`, events with `defineEmits<{}>()`.

## Nuxt UI v4 (as a Vue library, not Nuxt)

- `@nuxt/ui` is installed as a Vue plugin (`app.use(...)`), not through Nuxt
  auto-import. Tailwind is wired through the standard Tailwind layer.
- Prefer the library's components (`UButton`, `UModal`, `UCard`, …) over
  hand-rolled equivalents.
- Theming: semantic `ui.colors` plus Tailwind `@theme` tokens in
  `src/assets/css/main.css`. `app.config.ts` is the design-handoff source of
  truth; there is no Nuxt runtime to read it, so the live values are the
  `ui({ ui: { colors } })` block in `vite.config.ts`. **Update both in lockstep.**
- Plugin install order in `src/main.ts` is load-bearing: `installBridge()` →
  Pinia → PiniaColada → Nuxt UI. Colada's cache lives inside Pinia, and the
  onboarding gate calls the bridge on mount.
- The `ui()` Vite plugin gets `root: <repo root>` so generated `.nuxt-ui` theme
  templates land in the top-level `node_modules` where Tailwind scans them —
  otherwise utilities like `bg-default` / `ring-default` silently vanish.
  `router: false` because this is a single-window app with no vue-router.
- **Icons are bundled, not fetched.** `src/main.ts` registers the whole lucide
  collection with `addCollection()`. Outside a Nuxt build, `@iconify/vue`
  resolves an unknown icon name by calling `api.iconify.design` at runtime — which
  the app's CSP blocks (correctly), so every icon renders blank in a packaged
  build. Register the collection; don't open the CSP.
- `auto-imports.d.ts` / `components.d.ts` are generated and gitignored. On a
  fresh clone, run `pnpm dev` or `pnpm build:vite` once if type-check cannot
  resolve component types.

## Tree layout

App code lives directly under `src/` (`views/`, `components/`, `composables/`,
`stores/`, `utils/`, `bridge/`, `shared/`); `index.html` and `app.config.ts` sit
at the repo root. There is no vue-router: `App.vue` switches views with an
`activeView` ref.

## The bridge

- `src/bridge/index.ts` publishes a narrowly-typed `window.openproject.*` surface
  over Tauri's `invoke`. Typed methods only — never a generic fetch, never the
  API key.
- Command **names** live in that file and nowhere else.
- A rejected command arrives as a `BridgeError`: a real `Error` with `.message`
  for display and `.code` to branch on.

## Formatting

ESLint only (flat config); Prettier is not used. `pnpm lint` checks, `pnpm lint
--fix` formats.
