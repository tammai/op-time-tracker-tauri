<script setup lang="ts">
import { useMonthTimeEntries } from '@renderer/composables/queries/time-entries'
import { useUiStore } from '@renderer/stores/useUiStore'

/**
 * The app's single top row: calendar title (bold month, normal year) on the
 * left, the month total centred, and month navigation plus the icon actions on
 * the right — work packages, then settings. There is no app title.
 *
 * A plain `<header>` rather than `UDashboardNavbar`: with no sidebar, no
 * panel splitting and no second view, none of the dashboard chrome earned its
 * keep. It keeps the navbar's height (`--ui-header-height`) and padding, but
 * deliberately has **no bottom border** — the weekday row below already
 * supplies that rule, and two stacked lines read as a boxed-in header. The
 * three regions each take `flex-1` so the badge sits at the true centre
 * regardless of how wide the title or the button groups are.
 *
 * This stays a separate component from `App.vue` so `useMonthTimeEntries()` —
 * and therefore the time-entries request — is only created once the credential
 * gate has passed. `App.vue`'s setup runs *before* that gate resolves, so
 * calling the query there would fire a bridge request with no credentials
 * configured.
 *
 * It reads the same shared `useMonthTimeEntries()` instance the grid does, so
 * the title, the total, and the grid always agree on the displayed month.
 */

const ui = useUiStore()

const {
  monthName,
  yearLabel,
  totalHoursLabel,
  prevMonth,
  nextMonth,
  goToToday
} = useMonthTimeEntries()
</script>

<template>
  <header
    class="flex h-(--ui-header-height) shrink-0 items-center gap-1.5 px-4 sm:px-6"
  >
    <!-- Left: the calendar title. `leading-none` so the h1's box hugs the
         glyphs — with the header's `items-center`, a `text-2xl` line-height
         would centre a taller box than the badge and buttons, leaving the
         title visually sitting high next to them. -->
    <h1 class="flex min-w-0 flex-1 items-baseline gap-2 truncate leading-none">
      <span class="text-2xl font-bold text-highlighted">{{ monthName }}</span>
      <span class="text-2xl font-normal text-highlighted">{{ yearLabel }}</span>
    </h1>

    <!-- Centre: month total. Same `subtle` variant as the day badges in the
         grid and the day modal — an hours figure looks the same everywhere;
         only the size (`xl`) marks this one as the month's headline. -->
    <div class="flex flex-1 justify-center">
      <UBadge
        color="success"
        variant="soft"
        size="xl"
        class="tabular-nums"
        :label="totalHoursLabel"
      />
    </div>

    <!-- Right: month navigation, then the work-packages and settings actions.
         The gap separates them; buttons *within* a `UFieldGroup` stay flush by
         design.
         `subtle` throughout, matching the day modal's row actions — `soft`
         has no ring, so a grouped set of them reads as one unsplit slab. -->
    <div class="flex flex-1 items-center justify-end gap-3">
      <UFieldGroup size="md">
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-chevron-left"
          aria-label="Previous month"
          @click="prevMonth"
        />
        <UButton
          color="neutral"
          variant="subtle"
          label="Today"
          @click="goToToday"
        />
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-chevron-right"
          aria-label="Next month"
          @click="nextMonth"
        />
      </UFieldGroup>

      <UTooltip text="Work packages">
        <UButton
          color="neutral"
          variant="subtle"
          size="md"
          icon="i-lucide-list-checks"
          aria-label="Work packages"
          @click="ui.openWorkPackages"
        />
      </UTooltip>

      <UTooltip text="Settings">
        <UButton
          color="neutral"
          variant="subtle"
          size="md"
          icon="i-lucide-settings"
          aria-label="Settings"
          @click="ui.openSettings"
        />
      </UTooltip>
    </div>
  </header>
</template>
