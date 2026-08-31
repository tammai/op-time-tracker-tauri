import { defineQueryOptions } from '@pinia/colada'
import type { Project, ProjectCollection } from '@opentracker/preload'

/**
 * Projects domain query options — the projects a work package may be created
 * in.
 *
 * Its own domain file rather than another entry in `work-packages.ts`, for the
 * same reason `principals.ts` is separate: the resource is not a work-package
 * one. It is instance-wide and identical for every create, so it caches under
 * its own key and a work-package invalidation has no business dropping it —
 * creating a work package does not change which projects exist.
 *
 * Per `docs/conventions-frontend.md`: keys are defined once here,
 * and this file is the only place `window.openproject.listProjects` is called.
 */
export const projectQueries = {
  /**
   * Every project this API key may create a work package in.
   *
   * No parameters, so one stable key — the same shape as `statusQueries.list`.
   * The backend reads `available_projects` rather than the full project
   * collection, so an empty result means "this key may create nowhere", which
   * the create action reports rather than treating as an error.
   */
  list: defineQueryOptions(() => ({
    key: ['projects', 'list'],
    query: () => window.openproject.listProjects()
  }))
}

export type { Project, ProjectCollection }
