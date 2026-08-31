//! Parse tests against real OpenProject response bodies.
//!
//! The fixtures in `tests/fixtures/` were captured from a live instance and came
//! across from the Electron app unchanged, where they backed the Zod schema
//! tests. They are the only check that catches the failure mode a hand-written
//! JSON literal cannot: an instance-specific attribute, a differently spelled
//! Formattable, a `{"href": null}` where a string was assumed.
//!
//! A fixture that stops parsing means the serde models drifted from what a real
//! server sends — which is exactly the signal worth having in CI.

use op_time_tracker_lib::schemas::principals::PrincipalCollection;
use op_time_tracker_lib::schemas::projects::ProjectCollection;
use op_time_tracker_lib::schemas::statuses::StatusCollection;
use op_time_tracker_lib::schemas::time_entries::TimeEntryCollection;
use op_time_tracker_lib::schemas::work_packages::{
    normalize_work_package_create_form, normalize_work_package_form, WorkPackageCollection,
};
use op_time_tracker_lib::util::hal::{parse_work_package_id_from_href, PROJECT_PATH};
use op_time_tracker_lib::util::time::parse_hours_to_decimal;

fn fixture(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("fixture {name} is readable"))
}

#[test]
fn parses_a_live_work_packages_collection() {
    let collection: WorkPackageCollection =
        serde_json::from_str(&fixture("work-packages-collection.json")).expect("parses");

    assert!(!collection.elements().is_empty());
    for work_package in collection.elements() {
        assert!(work_package.id > 0);
        assert!(!work_package.subject.is_empty());
        // The one field the app refuses to do without.
        assert!(work_package.lock_version >= 0);
        // Every self href points back at the work package it belongs to.
        assert_eq!(
            parse_work_package_id_from_href(work_package.links.self_link.href()),
            Some(work_package.id)
        );
    }
}

#[test]
fn parses_a_live_time_entries_collection_and_every_duration_in_it() {
    let collection: TimeEntryCollection =
        serde_json::from_str(&fixture("time-entries-collection.json")).expect("parses");

    assert!(!collection.elements().is_empty());
    for entry in collection.elements() {
        assert!(entry.id > 0);
        // `hours` crosses to the frontend as a raw duration, so every one of
        // them has to be parseable by the shared converter.
        let hours = parse_hours_to_decimal(&entry.hours)
            .unwrap_or_else(|_| panic!("entry {} has an unparseable duration", entry.id));
        assert!(hours >= 0.0);
        // `spentOn` is what the calendar buckets by.
        assert_eq!(entry.spent_on.len(), 10);
    }
}

#[test]
fn parses_a_live_statuses_collection() {
    let collection: StatusCollection =
        serde_json::from_str(&fixture("statuses-collection.json")).expect("parses");
    assert!(!collection.elements().is_empty());
    for status in collection.elements() {
        assert!(status.id > 0);
        assert!(!status.name.is_empty());
    }
}

#[test]
fn parses_a_live_projects_collection() {
    let collection: ProjectCollection =
        serde_json::from_str(&fixture("projects-collection.json")).expect("parses");
    assert!(!collection.elements().is_empty());
    for project in collection.elements() {
        assert!(project.id > 0);
        assert!(!project.name.is_empty());
    }
}

#[test]
fn parses_a_live_available_assignees_collection() {
    let collection: PrincipalCollection =
        serde_json::from_str(&fixture("available-assignees-collection.json")).expect("parses");
    for principal in collection.elements() {
        assert!(principal.id > 0);
        assert!(!principal.name.is_empty());
        // Users, groups and placeholder users all arrive through this list.
        assert!(!principal.type_name.is_empty());
    }
}

#[test]
fn normalizes_a_live_edit_form_into_usable_selects() {
    let response: serde_json::Value =
        serde_json::from_str(&fixture("work-package-form.json")).expect("parses");
    let form = normalize_work_package_form(&response);

    // A real form's status list is the workflow's legal transitions, so it must
    // come out non-empty and href-free.
    assert!(!form.status.allowed_values.is_empty());
    for value in &form.status.allowed_values {
        assert!(value.id > 0);
        assert!(!value.name.is_empty());
    }
    assert!(!form.type_field.allowed_values.is_empty());
    assert!(form.subject.writable);
}

#[test]
fn normalizes_a_live_create_form_including_its_defaults() {
    let response: serde_json::Value =
        serde_json::from_str(&fixture("work-package-create-form.json")).expect("parses");
    let form = normalize_work_package_create_form(&response);

    assert!(!form.type_field.allowed_values.is_empty());
    // OpenProject's own defaults are what make a create form usable without
    // asking the user to invent a status.
    assert!(form.defaults.type_id.is_some());
    // Each default, when present, has to be one of the offered values.
    if let Some(type_id) = form.defaults.type_id {
        assert!(form
            .type_field
            .allowed_values
            .iter()
            .any(|value| value.id == type_id));
    }
    if let Some(status_id) = form.defaults.status_id {
        assert!(status_id > 0);
    }
}

#[test]
fn a_work_packages_project_id_is_readable_from_its_own_links() {
    // The create/edit flow depends on this: the assignee list is fetched by
    // *project* id, which is only available as an href on the work package.
    let collection: WorkPackageCollection =
        serde_json::from_str(&fixture("work-packages-collection.json")).expect("parses");
    let with_project = collection
        .elements()
        .iter()
        .find(|wp| wp.links.project.is_some())
        .expect("a fixture work package with a project link");
    let project_id = op_time_tracker_lib::util::hal::parse_resource_id_from_href(
        PROJECT_PATH,
        with_project
            .links
            .project
            .as_ref()
            .and_then(|link| link.href()),
    );
    assert!(project_id.is_some_and(|id| id > 0));
}
