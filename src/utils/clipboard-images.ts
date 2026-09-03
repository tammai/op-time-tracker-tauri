/**
 * Reading an image out of a paste, and getting its bytes across the bridge.
 *
 * Pure functions here rather than inline in the editor component, because the
 * awkward cases are the whole content: a screenshot pasted from the OS arrives
 * with no usable file name, and `btoa` cannot be handed a whole image in one
 * call. Both are testable; neither is reachable from inside a `.vue` file.
 */

/** Extensions for the image types a paste realistically produces. */
const EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp'
}

/**
 * The first image in a paste or drop payload, if there is one.
 *
 * `null` for a text paste, which is the common case and must fall through to
 * the editor's own handling untouched — consuming every paste would break
 * copying a paragraph.
 *
 * Only the *first* image: a clipboard carries one screenshot, and a multi-image
 * paste is not something an OS clipboard produces.
 */
export function imageFileFromTransfer(transfer: DataTransfer | null): File | null {
  if (!transfer) return null
  for (const file of Array.from(transfer.files)) {
    if (file.type.toLowerCase().startsWith('image/')) return file
  }
  return null
}

/**
 * A file name for a pasted image.
 *
 * A screenshot from the OS clipboard has no name — Chromium reports
 * `image.png`, or an empty string — so several pastes into one work package
 * would all be called the same thing and be indistinguishable in the
 * attachments list. A timestamp is what makes them tellable apart.
 *
 * A name the user's own file *did* carry is kept: dragging `diagram.png` in
 * should attach `diagram.png`.
 */
export function pastedImageFileName(file: File, now: Date = new Date()): string {
  const generic = new Set(['', 'image.png', 'image', 'blob', 'clipboard.png'])
  const supplied = file.name.trim()
  if (!generic.has(supplied.toLowerCase())) return supplied

  const extension = EXTENSIONS[file.type.toLowerCase()] ?? 'png'
  // `2026-09-03T14-22-05` — sortable, and legal on every platform this ships
  // to (Windows rejects the colons an ISO time would carry).
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `pasted-image-${stamp}.${extension}`
}

/**
 * Base64-encode bytes for the upload command.
 *
 * Chunked, which is the point of the function: `String.fromCharCode(...bytes)`
 * spreads every byte as an argument, and a screenshot large enough to be worth
 * attaching overflows the call stack. 32 KB per call is comfortably inside every
 * engine's argument limit.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** Read a `File` into the base64 the upload command takes. */
export async function fileToBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()))
}
