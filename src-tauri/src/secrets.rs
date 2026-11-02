//! Saved host passwords, stored in the OS keychain (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service) via the `keyring` crate — never in the
//! TOML config files. Each password is keyed by the host's id.
//!
//! The frontend saves/clears a password when a host is added or edited; the SSH
//! connect path (`ssh::open_authenticated`) reads it back with
//! `load_host_password` so a saved host connects without a prompt.

use keyring::{Entry, Error};

/// Keychain service name. Stable so entries survive restarts; matches the app's
/// bundle identifier.
const SERVICE: &str = "com.devstudio.sshmanger";

fn entry(host_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, host_id).map_err(|e| format!("Keychain unavailable: {e}"))
}

/// Save (or replace) the password for a host.
#[tauri::command]
pub fn save_host_password(host_id: String, password: String) -> Result<(), String> {
    entry(&host_id)?
        .set_password(&password)
        .map_err(|e| format!("Could not save password: {e}"))
}

/// Remove a host's saved password. A missing entry is not an error.
#[tauri::command]
pub fn delete_host_password(host_id: String) -> Result<(), String> {
    match entry(&host_id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove saved password: {e}")),
    }
}

/// Whether a host has a saved password (so the UI can show a "saved" hint).
#[tauri::command]
pub fn has_host_password(host_id: String) -> Result<bool, String> {
    match entry(&host_id)?.get_password() {
        Ok(_) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

/// Fetch a host's saved password, if any. Used by the connect path; never
/// logged. Returns `None` when nothing is stored or the keychain is unreachable.
pub fn load_host_password(host_id: &str) -> Option<String> {
    Entry::new(SERVICE, host_id).ok()?.get_password().ok()
}
