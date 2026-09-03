import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * Files dropped onto the window, routed to whichever zone was under the cursor.
 *
 * ## Why this is not an HTML5 drop handler
 *
 * Tauri intercepts the window's native drop before the webview sees it, so
 * `@dragover`/`@drop` on an element never fire — the payload arrives as a Tauri
 * event instead, carrying **OS file paths** rather than `File` objects. That is
 * why this exists at all, and why the upload path for a drop takes paths while
 * the one for a paste takes bytes.
 *
 * ## Why one listener for every zone
 *
 * The event is delivered to the *window*, not to an element, so there is no
 * bubbling and no `event.target` — every registered listener sees every drop.
 * With one listener per component, dropping on the description editor would
 * both insert an image *and* attach the file to the panel behind it.
 *
 * So the listener is a module-level singleton and zones register a rectangle
 * with it. A drop goes to the highest-priority zone whose element contains the
 * point, and to nothing else. Priority rather than DOM depth because the
 * nesting is not always the answer: the editor sits inside the panel and must
 * win, and stating that as a number beats inferring it from a rect comparison.
 */

/** Priorities, so the two call sites cannot disagree about who wins. */
export const DROP_PRIORITY = {
  /** The work package detail panel: attach the file. */
  panel: 0,
  /** The description editor: attach it *and* insert it at the cursor. */
  editor: 10
} as const

interface Zone {
  element: () => HTMLElement | null
  enabled: () => boolean
  isOver: Ref<boolean>
  onDrop: (paths: string[]) => void
  priority: number
}

const zones = new Set<Zone>()
let stopListening: (() => void) | null = null
let listenerStarting: Promise<void> | null = null

function contains(zone: Zone, x: number, y: number): boolean {
  if (!zone.enabled()) return false
  const element = zone.element()
  if (!element) return false
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function zoneAt(x: number, y: number): Zone | null {
  let winner: Zone | null = null
  for (const zone of zones) {
    if (!contains(zone, x, y)) continue
    if (!winner || zone.priority > winner.priority) winner = zone
  }
  return winner
}

function highlight(active: Zone | null): void {
  for (const zone of zones) zone.isOver.value = zone === active
}

/**
 * Tauri reports the cursor in **physical** pixels; `getBoundingClientRect` is
 * in CSS pixels. On any display with a scale factor other than 1 — every Mac
 * with a Retina screen — skipping this conversion puts the point at roughly
 * twice its real coordinates, which lands outside every zone.
 */
function toCssPixels(position: { x: number; y: number }): { x: number; y: number } {
  const scale = window.devicePixelRatio || 1
  return { x: position.x / scale, y: position.y / scale }
}

async function ensureListener(): Promise<void> {
  if (stopListening) return
  if (listenerStarting) return listenerStarting

  listenerStarting = (async () => {
    try {
      // Imported lazily so a non-Tauri context (a unit test, `vite preview`)
      // does not fail at module load over an API that only exists in the app.
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      stopListening = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload

        if (payload.type === 'leave') {
          highlight(null)
          return
        }

        const { x, y } = toCssPixels(payload.position)
        const target = zoneAt(x, y)

        if (payload.type === 'drop') {
          highlight(null)
          // A drop outside every zone is not ours: dropping a file on the
          // calendar should do nothing, not attach it to whatever was last
          // selected.
          if (target) target.onDrop([...payload.paths])
          return
        }

        // `enter` and `over` both carry a position; both just move the
        // highlight.
        highlight(target)
      })
    } catch {
      // Not running under Tauri, or the webview refused the listener. Drag and
      // drop is an accelerator for the file picker, never the only way in, so
      // this degrades to "the button still works".
    } finally {
      listenerStarting = null
    }
  })()

  return listenerStarting
}

/**
 * Register one drop zone for the lifetime of the calling component.
 *
 * `isOver` is true while a drag is over *this* zone and no higher-priority zone
 * claims the point, so a component can show its own drop affordance.
 */
export function useFileDrop(options: {
  element: () => HTMLElement | null
  enabled?: () => boolean
  onDrop: (paths: string[]) => void
  priority: number
}): { isOver: Ref<boolean> } {
  const isOver = ref(false)
  const zone: Zone = {
    element: options.element,
    enabled: options.enabled ?? (() => true),
    isOver,
    onDrop: options.onDrop,
    priority: options.priority
  }

  zones.add(zone)
  void ensureListener()

  onBeforeUnmount(() => {
    zones.delete(zone)
    // The listener is left running when the last zone unregisters. It costs one
    // idle IPC subscription, and the panels that use it are opened and closed
    // repeatedly — re-establishing it each time is the more expensive choice.
  })

  return { isOver }
}
