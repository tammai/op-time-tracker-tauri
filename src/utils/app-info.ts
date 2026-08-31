/**
 * Build-time app identity, shown in the settings footer.
 *
 * `__APP_VERSION__` / `__APP_AUTHOR__` are Vite `define` replacements fed
 * from `package.json` (see the `define` blocks in `vite.config.ts`
 * and `vitest.config.ts`). The manifest stays the single source of truth, so
 * the footer can't drift from the version that actually shipped — bumping
 * `package.json` is the only edit needed.
 *
 * The `typeof` guards keep this module importable where the defines aren't
 * injected; a bare reference to a missing global would throw at import time.
 */

declare const __APP_VERSION__: string | undefined
declare const __APP_AUTHOR__: string | undefined
declare const __APP_AUTHOR_EMAIL__: string | undefined

/** Product name. Not `package.json`'s `name` — that's the npm slug. */
export const APP_NAME = 'OpenProject Time Tracker'

export const APP_VERSION =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

/**
 * `package.json`'s `author`, normalized to a plain name. Empty when unset —
 * the footer then omits the attribution rather than showing a blank separator.
 */
export const APP_AUTHOR =
  typeof __APP_AUTHOR__ === 'string' ? __APP_AUTHOR__ : ''

/** `package.json`'s `author.email`. Shown as the footer's contact line. */
export const APP_AUTHOR_EMAIL =
  typeof __APP_AUTHOR_EMAIL__ === 'string' ? __APP_AUTHOR_EMAIL__ : ''
