/**
 * OpenProject connection defaults shared by both trees.
 *
 * Lives in `src/shared/` because the frontend prefills its credential form
 * with it and the backend has no business owning a UI default — see
 * `docs/architecture.md`. It is a plain convenience default, not
 * a trusted value: every code path still runs it through
 * `OpenProjectBaseUrlSchema` before building a request from it.
 */

/** The instance this app is built for. Prefilled in onboarding + settings. */
export const DEFAULT_OPENPROJECT_BASE_URL = 'https://op.bigin.vn'
