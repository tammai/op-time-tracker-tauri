/**
 * The bridge: `window.openproject.*` over Tauri's `invoke`.
 *
 * Successor to the Electron app's preload script. It occupies the same place in
 * the architecture — the one module that knows how to reach the backend — and
 * keeps the same surface, which is why the Vue components, composables and
 * queries came across unchanged.
 *
 * Two things it does beyond forwarding calls:
 *
 * 1. **Names.** Each method maps to one snake_case Rust command. That mapping
 *    lives here and nowhere else.
 * 2. **Errors.** A rejected command hands back a plain `{ code, message }`
 *    object, which would give components a thrown value with no `.message` and
 *    no stack. `toBridgeError` turns it into a real `Error` carrying `.code`, so
 *    `err.message` renders and `err.code === 'OPENPROJECT_CONFLICT'` still
 *    branches.
 *
 * There is deliberately no method that returns the API key. See
 * `docs/security.md`.
 */

import { invoke } from '@tauri-apps/api/core'

import type {
  AvailableAssigneesInput,
  ConnectionInfo,
  CreateTimeEntryInput,
  CreateWorkPackageInput,
  DeleteTimeEntryInput,
  ListTimeEntriesInput,
  ListTimeEntryActivitiesInput,
  ListWorkPackagesInput,
  OpenProjectBridge,
  OpenWorkPackageInBrowserInput,
  Principal,
  PrincipalCollection,
  ProjectCollection,
  SaveCredentialsInput,
  StatusCollection,
  TestConnectionInput,
  TestConnectionResult,
  TimeEntry,
  TimeEntryActivityCollection,
  TimeEntryCollection,
  UpdateTimeEntryInput,
  UpdateWorkPackageInput,
  WorkPackage,
  WorkPackageCollection,
  WorkPackageCreateForm,
  WorkPackageCreateFormInput,
  WorkPackageForm,
  WorkPackageFormInput
} from './types'

/**
 * An `Error` that also carries the backend's stable code.
 *
 * A subclass rather than a decorated object literal so `instanceof Error` holds
 * — Vue's own error handling and the `err?.message` reads scattered through the
 * components both rely on it.
 */
export class BridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * Normalize whatever a rejected `invoke` produced into a `BridgeError`.
 *
 * The expected case is the `{ code, message }` our commands return. The others
 * are real but rare: a command that panics rejects with a string, and a
 * malformed invocation (a name that doesn't exist, an argument that won't
 * deserialize) rejects with Tauri's own message. Neither should reach the user
 * as `[object Object]`.
 */
function toBridgeError(raw: unknown): BridgeError {
  if (raw instanceof BridgeError) return raw

  if (typeof raw === 'object' && raw !== null) {
    const shape = raw as { code?: unknown; message?: unknown }
    if (typeof shape.code === 'string' && typeof shape.message === 'string') {
      return new BridgeError(shape.code, shape.message)
    }
    if (raw instanceof Error) {
      return new BridgeError('BRIDGE_UNKNOWN', raw.message)
    }
  }

  if (typeof raw === 'string' && raw.length > 0) {
    return new BridgeError('BRIDGE_UNKNOWN', raw)
  }

  return new BridgeError(
    'BRIDGE_UNKNOWN',
    'An unexpected error occurred while contacting OpenProject.'
  )
}

/** Invoke one command, re-throwing any failure as a `BridgeError`. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (raw) {
    throw toBridgeError(raw)
  }
}

export const bridge: OpenProjectBridge = {
  // Credentials
  hasCredentials: () => call<boolean>('has_credentials'),
  getConnectionInfo: () => call<ConnectionInfo>('get_connection_info'),
  saveCredentials: (input: SaveCredentialsInput) =>
    call<void>('save_credentials', { input }),
  clearCredentials: () => call<void>('clear_credentials'),
  testConnection: (input: TestConnectionInput) =>
    call<TestConnectionResult>('test_connection', { input }),

  // Reads
  listWorkPackages: (input?: ListWorkPackagesInput) =>
    call<WorkPackageCollection>('list_work_packages', { input: input ?? null }),
  listTimeEntries: (input?: ListTimeEntriesInput) =>
    call<TimeEntryCollection>('list_time_entries', { input: input ?? null }),
  listStatuses: () => call<StatusCollection>('list_statuses'),
  listTimeEntryActivities: (input?: ListTimeEntryActivitiesInput) =>
    call<TimeEntryActivityCollection>('list_time_entry_activities', {
      input: input ?? null
    }),
  getWorkPackageForm: (input: WorkPackageFormInput) =>
    call<WorkPackageForm>('get_work_package_form', { input }),
  getWorkPackageCreateForm: (input: WorkPackageCreateFormInput) =>
    call<WorkPackageCreateForm>('get_work_package_create_form', { input }),
  listAvailableAssignees: (input: AvailableAssigneesInput) =>
    call<PrincipalCollection>('list_available_assignees', { input }),
  getCurrentUser: () => call<Principal>('get_current_user'),
  listProjects: () => call<ProjectCollection>('list_projects'),

  // Writes
  createTimeEntry: (input: CreateTimeEntryInput) =>
    call<TimeEntry>('create_time_entry', { input }),
  updateTimeEntry: (input: UpdateTimeEntryInput) =>
    call<TimeEntry>('update_time_entry', { input }),
  deleteTimeEntry: (input: DeleteTimeEntryInput) =>
    call<void>('delete_time_entry', { input }),
  updateWorkPackage: (input: UpdateWorkPackageInput) =>
    call<WorkPackage>('update_work_package', { input }),
  createWorkPackage: (input: CreateWorkPackageInput) =>
    call<WorkPackage>('create_work_package', { input }),

  // Shell
  openWorkPackageInBrowser: (input: OpenWorkPackageInBrowserInput) =>
    call<void>('open_work_package_in_browser', { input })
}

/**
 * Publish the bridge as `window.openproject`.
 *
 * Kept as the access path rather than importing `bridge` in every caller
 * because it is what the frontend was written against: the query layer's
 * "`window.openproject.*` is called in exactly one place per resource" rule, and
 * the tests that stub the global, both survive the port unchanged.
 */
export function installBridge(): void {
  window.openproject = bridge
}

export type * from './types'
