//! The OpenProject data commands.
//!
//! Port of `src/main/ipc/openproject.ts`. Each one resolves credentials, builds
//! a client, and delegates — the validation and the request building live in the
//! client and the schemas, so a command is the thin part on purpose.

use serde::Deserialize;
use tauri::AppHandle;

use crate::credentials::{CredentialStore, Credentials};
use crate::error::AppError;
use crate::openproject::client::OpenProjectClient;
use crate::openproject::filters::{TimeEntryFilters, WorkPackageFilters};
use crate::schemas::principals::{Principal, PrincipalCollection};
use crate::schemas::projects::ProjectCollection;
use crate::schemas::statuses::StatusCollection;
use crate::schemas::time_entries::{
    CreateTimeEntryInput, DeleteTimeEntryInput, TimeEntry, TimeEntryActivityCollection,
    TimeEntryCollection, UpdateTimeEntryInput,
};
use crate::schemas::work_packages::{
    AvailableAssigneesInput, CreateWorkPackageInput, UpdateWorkPackageInput, WorkPackage,
    WorkPackageCollection, WorkPackageCreateForm, WorkPackageCreateFormInput, WorkPackageForm,
    WorkPackageFormInput,
};

/// Resolve credentials or fail with the code the onboarding gate watches for.
fn client(app: &AppHandle) -> Result<OpenProjectClient, AppError> {
    let credentials: Credentials = CredentialStore::new(app)?
        .credentials()?
        .ok_or_else(AppError::credential_not_configured)?;
    OpenProjectClient::new(credentials)
}

/// Optional filter wrappers, matching the old bridge's `{ filters }` argument
/// shape so the frontend call sites are unchanged.
#[derive(Debug, Default, Deserialize)]
pub struct ListWorkPackagesInput {
    #[serde(default)]
    pub filters: Option<WorkPackageFilters>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ListTimeEntriesInput {
    #[serde(default)]
    pub filters: Option<TimeEntryFilters>,
}

/// Optional scoping for the activities list: passing the work package the user
/// is logging against limits the activities to the ones allowed in its project.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTimeEntryActivitiesInput {
    #[serde(default)]
    pub work_package_id: Option<i64>,
}

#[tauri::command]
pub async fn list_work_packages(
    app: AppHandle,
    input: Option<ListWorkPackagesInput>,
) -> Result<WorkPackageCollection, AppError> {
    let filters = input.and_then(|input| input.filters).unwrap_or_default();
    client(&app)?.list_work_packages(&filters).await
}

#[tauri::command]
pub async fn list_time_entries(
    app: AppHandle,
    input: Option<ListTimeEntriesInput>,
) -> Result<TimeEntryCollection, AppError> {
    let filters = input.and_then(|input| input.filters).unwrap_or_default();
    client(&app)?.list_time_entries(&filters).await
}

#[tauri::command]
pub async fn list_statuses(app: AppHandle) -> Result<StatusCollection, AppError> {
    client(&app)?.list_statuses().await
}

#[tauri::command]
pub async fn list_time_entry_activities(
    app: AppHandle,
    input: Option<ListTimeEntryActivitiesInput>,
) -> Result<TimeEntryActivityCollection, AppError> {
    let work_package_id = input.and_then(|input| input.work_package_id);
    client(&app)?
        .list_time_entry_activities(work_package_id)
        .await
}

#[tauri::command]
pub async fn create_time_entry(
    app: AppHandle,
    input: CreateTimeEntryInput,
) -> Result<TimeEntry, AppError> {
    client(&app)?.create_time_entry(&input).await
}

#[tauri::command]
pub async fn update_time_entry(
    app: AppHandle,
    input: UpdateTimeEntryInput,
) -> Result<TimeEntry, AppError> {
    client(&app)?.update_time_entry(&input).await
}

/// Irreversible: OpenProject has no server-side undo for a deleted entry.
#[tauri::command]
pub async fn delete_time_entry(
    app: AppHandle,
    input: DeleteTimeEntryInput,
) -> Result<(), AppError> {
    client(&app)?.delete_time_entry(input.id).await
}

#[tauri::command]
pub async fn get_work_package_form(
    app: AppHandle,
    input: WorkPackageFormInput,
) -> Result<WorkPackageForm, AppError> {
    client(&app)?.get_work_package_form(&input).await
}

#[tauri::command]
pub async fn get_work_package_create_form(
    app: AppHandle,
    input: WorkPackageCreateFormInput,
) -> Result<WorkPackageCreateForm, AppError> {
    client(&app)?.get_work_package_create_form(&input).await
}

#[tauri::command]
pub async fn list_available_assignees(
    app: AppHandle,
    input: AvailableAssigneesInput,
) -> Result<PrincipalCollection, AppError> {
    client(&app)?.list_available_assignees(&input).await
}

#[tauri::command]
pub async fn get_current_user(app: AppHandle) -> Result<Principal, AppError> {
    client(&app)?.get_current_user().await
}

#[tauri::command]
pub async fn list_projects(app: AppHandle) -> Result<ProjectCollection, AppError> {
    client(&app)?.list_projects().await
}

#[tauri::command]
pub async fn update_work_package(
    app: AppHandle,
    input: UpdateWorkPackageInput,
) -> Result<WorkPackage, AppError> {
    client(&app)?.update_work_package(&input).await
}

#[tauri::command]
pub async fn create_work_package(
    app: AppHandle,
    input: CreateWorkPackageInput,
) -> Result<WorkPackage, AppError> {
    client(&app)?.create_work_package(&input).await
}
