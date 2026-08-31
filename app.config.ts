/**
 * Nuxt UI semantic theme config (Vue-only install).
 *
 * In a Nuxt app this file would be read by the Nuxt module at runtime via
 * `defineAppConfig`. In the Vue-only (Vite) install used by this Tauri
 * renderer there is no Nuxt runtime, so the live config is injected through
 * the `ui({ ui: { colors } })` option in `vite.config.ts`.
 *
 * This file is kept as the design-handoff source of truth: the `ui.colors`
 * block in `vite.config.ts` mirrors the values here. When the
 * theme changes, update both in lockstep.
 */
export default {
  ui: {
    colors: {
      primary: 'blue',
      neutral: 'slate'
    }
  }
}