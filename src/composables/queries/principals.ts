import { defineQueryOptions } from '@pinia/colada'
import type { Principal, PrincipalCollection } from '@opentracker/preload'

/**
 * Principals domain query options — the users, groups and placeholder users a
 * work package can be assigned to.
 *
 * Its own domain file rather than a fourth entry in `work-packages.ts`, because
 * the resource genuinely is not a work-package one: the list is scoped to a
 * **project** (`GET /api/v3/projects/{id}/available_assignees`), so it is
 * shared by every work package in that project and must cache on the project
 * id, not on the work package the user happens to have selected. Keying it
 * under `['work-packages', …]` would refetch the same nine people for every row
 * and let a work-package invalidation drop a cache entry that has nothing to do
 * with the write.
 *
 * Per `docs/conventions-frontend.md`: keys are defined once here,
 * and this file is the only place `window.openproject.listAvailableAssignees`
 * is called.
 */
export const principalQueries = {
  /**
   * Assignable principals for a project.
   *
   * `projectId` is a plain number the caller read off the work package it
   * already holds (`workPackageProjectId`). The backend rebuilds the
   * request path from it — no href crosses the bridge.
   *
   * Callers gate on `enabled` rather than passing a placeholder id: there is no
   * project id worth querying when the work package's project link is
   * unreadable, and a query keyed on a sentinel would cache a failure.
   */
  availableAssignees: defineQueryOptions((projectId: number) => ({
    key: ['principals', 'available-assignees', projectId],
    query: () => window.openproject.listAvailableAssignees({ projectId })
  })),

  /**
   * The user the stored key authenticates as.
   *
   * One stable key and no parameters — the identity can't change without the
   * credentials changing, which reloads the app — so Colada caches it for the
   * session and every create reads the same copy.
   */
  currentUser: defineQueryOptions(() => ({
    key: ['principals', 'current-user'],
    query: () => window.openproject.getCurrentUser()
  }))
}

export type { Principal, PrincipalCollection }
