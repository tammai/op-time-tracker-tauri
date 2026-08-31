//! Pure helpers shared by the client, the schemas, and the commands. Nothing
//! here touches the network, the keychain, or Tauri — which is what makes it
//! all unit-testable without a running app.

pub mod hal;
pub mod time;
pub mod validation;
