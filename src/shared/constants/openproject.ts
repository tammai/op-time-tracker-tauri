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

/**
 * The URI scheme this app serves attachment bytes on.
 *
 * `/api/v3/attachments/{id}/content` needs an `Authorization` header an `<img>`
 * cannot send, and the API key never reaches the webview, so the backend serves
 * the bytes on its own scheme instead and rewrites every inline attachment URL
 * in a description to point at it. See
 * `src-tauri/src/attachment_protocol.rs`.
 *
 * The frontend never *builds* one of these URLs — an attachment carries its own
 * `proxyUrl`, and descriptions arrive already rewritten. It is named here so the
 * renderer can recognise the scheme as a legitimate image source.
 */
export const ATTACHMENT_PROXY_SCHEME = 'opattach'

/**
 * The origin Windows serves the scheme above from.
 *
 * WebView2 has no custom-scheme support, so Tauri maps a registered scheme to
 * `http://<scheme>.localhost` there. Both spellings are accepted whichever
 * platform is running: a description written on one OS is edited on the other.
 */
export const ATTACHMENT_PROXY_WINDOWS_HOST = `${ATTACHMENT_PROXY_SCHEME}.localhost`
