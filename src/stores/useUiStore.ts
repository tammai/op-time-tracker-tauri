import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Client-side UI state for the single-screen shell: which overlay is open,
 * and what the day modal is currently pointed at.
 *
 * This is *client* state, not server state, so it belongs in a Pinia store
 * rather than a Colada query (`docs/conventions-frontend.md` —
 * "Global state: Pinia stores. Async data: Pinia Colada"). It lives here
 * rather than in `App.vue` because the overlays and their triggers are
 * siblings: the header's settings action, a calendar cell opening the day
 * modal, and the modals themselves (mounted in `App.vue`). Passing that
 * through props and events would thread state through the whole tree for no
 * benefit.
 */
export const useUiStore = defineStore('ui', () => {
  /** Settings modal. */
  const isSettingsOpen = ref(false)

  /** Keep the settings modal mounted after its first open so its close
   * transition can finish while still avoiding an eager bundle request. */
  const hasOpenedSettings = ref(false)

  /** Day modal. */
  const isDayModalOpen = ref(false)

  /** Work-packages browse modal. */
  const isWorkPackagesOpen = ref(false)

  /**
   * Whether the work-packages modal has ever been opened.
   *
   * It gates the modal's *mount* in `App.vue`, separately from its visibility,
   * for two reasons. Mounting it up front would fire its work-packages and
   * statuses queries at app start, before the user has asked for any of it —
   * the same reason the calendar header is its own component. And a plain
   * `v-if` on `isWorkPackagesOpen` would unmount the modal the instant it
   * closes, cutting off its own close transition. Latching on first open gives
   * both: nothing loads until asked, and once loaded the list stays warm so
   * reopening is instant.
   */
  const hasOpenedWorkPackages = ref(false)

  /** Work-package create drawer — opened from the calendar's floating button. */
  const isCreateDrawerOpen = ref(false)

  /**
   * Whether the create drawer has ever been opened — same latch as
   * `hasOpenedWorkPackages`. The drawer's `useWorkPackageCreator` fires a
   * projects query on mount, so it must not mount at app start; and a plain
   * `v-if` on `isCreateDrawerOpen` would cut off its close transition.
   */
  const hasOpenedCreateDrawer = ref(false)

  /**
   * The day the modal is logging against, as `YYYY-MM-DD`. `null` only
   * before the modal has ever been opened — the modal itself is never
   * rendered without a date.
   */
  const activeDate = ref<string | null>(null)

  function openSettings(): void {
    hasOpenedSettings.value = true
    isSettingsOpen.value = true
  }

  /** Open the work-packages browse modal — called from the header. */
  function openWorkPackages(): void {
    hasOpenedWorkPackages.value = true
    isWorkPackagesOpen.value = true
  }

  /** Open the create drawer — called from the calendar's floating button. */
  function openCreateDrawer(): void {
    hasOpenedCreateDrawer.value = true
    isCreateDrawerOpen.value = true
  }

  /** Open the day modal for `date` — called from a calendar cell. */
  function openDay(date: string): void {
    activeDate.value = date
    isDayModalOpen.value = true
  }

  /**
   * Close the day modal. `activeDate` is deliberately left in place:
   * clearing it would blank the modal's content for the frame the close
   * transition is still animating.
   */
  function closeDay(): void {
    isDayModalOpen.value = false
  }

  return {
    isSettingsOpen,
    hasOpenedSettings,
    isDayModalOpen,
    isWorkPackagesOpen,
    hasOpenedWorkPackages,
    isCreateDrawerOpen,
    hasOpenedCreateDrawer,
    activeDate,
    openSettings,
    openWorkPackages,
    openCreateDrawer,
    openDay,
    closeDay
  }
})
