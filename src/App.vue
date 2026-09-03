<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'

import CalendarView from './views/CalendarView.vue'
import CalendarHeader from './components/CalendarHeader.vue'
import { useUiStore } from './stores/useUiStore'

// The calendar is the only configured-user startup surface. Onboarding and all
// overlays are loaded when their gate/action first needs them, allowing Vite to
// keep each surface's Nuxt UI controls out of the initial bundle.
const OnboardingView = defineAsyncComponent(() => import('./views/OnboardingView.vue'))
const DayEntriesModal = defineAsyncComponent(
  () => import('./components/DayEntriesModal.vue')
)
const SettingsModal = defineAsyncComponent(
  () => import('./components/SettingsModal.vue')
)
const WorkPackagesModal = defineAsyncComponent(
  () => import('./components/WorkPackagesModal.vue')
)
const WorkPackageCreateDrawer = defineAsyncComponent(
  () => import('./components/WorkPackageCreateDrawer.vue')
)

/**
 * App shell — one screen.
 *
 * On mount we ask the backend whether credentials are configured.
 * While that's in flight we show a neutral loading state so the onboarding
 * form doesn't flash before the answer arrives. Configured → the single
 * `UDashboardPanel` shell, whose one header row *is* the calendar header:
 * month + year on the left, the month total centred, and month navigation
 * plus the settings action on the right. The calendar body below it renders
 * only the grid. Otherwise → `OnboardingView`, which emits `configured` once
 * credentials are saved so we flip straight to the shell without re-querying.
 *
 * The header reads `useMonthTimeEntries()` — the same shared instance the grid
 * uses — so the title, the total, and the grid can never disagree about which
 * month is displayed.
 *
 * The day and settings panels are modals mounted here and opened through
 * `useUiStore`: a calendar cell opens the day modal, the header opens
 * settings, so their visibility can't live in either component alone.
 */

type Gate = 'loading' | 'configured' | 'onboarding'

const gate = ref<Gate>('loading')

const ui = useUiStore()

onMounted(async () => {
  try {
    const has = await window.openproject.hasCredentials()
    gate.value = has ? 'configured' : 'onboarding'
  } catch {
    // If the credential check itself throws (store not ready / read error),
    // fall back to onboarding so the user can (re-)enter credentials rather
    // than staring at a spinner forever.
    gate.value = 'onboarding'
  }
})

function onConfigured(): void {
  gate.value = 'configured'
}

/** Settings cleared the credentials — hand back to onboarding. */
function onDisconnected(): void {
  gate.value = 'onboarding'
}

/**
 * Whether the "new work package" floating button is shown.
 *
 * It floats over the calendar, so it hides the moment any overlay covers the
 * screen — the day, work-packages, or settings modal, or the create drawer it
 * itself opens — rather than poking through above them. `fixed` places it
 * relative to the viewport, which is why it isn't a child of the `UMain` flex
 * column.
 */
const fabVisible = computed(
  () =>
    !ui.isDayModalOpen &&
    !ui.isWorkPackagesOpen &&
    !ui.isSettingsOpen &&
    !ui.isCreateDrawerOpen
)
</script>

<template>
  <!-- Toasts here are short confirmations of a write the user just made — the
       result is already visible in the list behind them, so Nuxt UI's 5s
       default outstays its welcome. Set once on the toaster rather than per
       `toast.add()` call, so every site stays consistent. -->
  <UApp :toaster="{ duration: 3000 }">
    <!-- Loading: avoid flashing onboarding before hasCredentials() resolves. -->
    <div
      v-if="gate === 'loading'"
      class="flex h-screen items-center justify-center"
    >
      <div class="text-muted flex items-center gap-2">
        <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
        <span class="text-sm">Starting up…</span>
      </div>
    </div>

    <!-- Onboarding gate: shown when no credentials are configured. -->
    <OnboardingView
      v-else-if="gate === 'onboarding'"
      @configured="onConfigured"
    />

    <!-- Main shell: one top row + the calendar grid, nothing else.
         `h-screen` because `UMain`'s own `min-h` subtracts a header height
         that no longer applies here, and the grid needs a bounded parent to
         divide into rows rather than overflow. -->
    <template v-else>
      <UMain class="flex h-screen flex-col overflow-hidden">
        <CalendarHeader />
        <CalendarView class="min-h-0 flex-1" />
      </UMain>

      <!-- The floating "new work package" action. A solid circular button
           pinned bottom-right of the calendar; clicking it opens the create
           drawer. `fixed` so it floats over the grid regardless of how the
           shell's flex column lays out. -->
      <UTooltip v-if="fabVisible" text="New work package" :content="{ side: 'left' }">
        <UButton
          color="primary"
          size="xl"
          icon="i-lucide-plus"
          aria-label="New work package"
          class="fixed bottom-6 right-6 z-50 rounded-full shadow-lg"
          @click="ui.openCreateDrawer()"
        />
      </UTooltip>

      <!-- Overlays, mounted once for the whole shell. -->
      <DayEntriesModal
        v-if="ui.activeDate"
        v-model:open="ui.isDayModalOpen"
        :date="ui.activeDate"
      />

      <!-- Mounted only once the user has asked for it, so its queries don't
           fire at app start; kept mounted afterwards so closing it doesn't cut
           off its own transition, and so reopening finds the list warm. See
           `hasOpenedWorkPackages` in `useUiStore`. -->
      <WorkPackagesModal
        v-if="ui.hasOpenedWorkPackages"
        v-model:open="ui.isWorkPackagesOpen"
      />

      <!-- Mounted on the same latch as the work-packages modal: the drawer's
           `useWorkPackageCreator` fires a projects query on mount, so it stays
           unmounted until the floating button is first pressed; latching keeps
           it mounted afterwards so its close transition plays out. -->
      <WorkPackageCreateDrawer
        v-if="ui.hasOpenedCreateDrawer"
        v-model:open="ui.isCreateDrawerOpen"
      />

      <SettingsModal
        v-if="ui.hasOpenedSettings"
        v-model:open="ui.isSettingsOpen"
        @disconnected="onDisconnected"
      />
    </template>
  </UApp>
</template>
