//! Saved host passwords, keyed by host id — never written to the TOML config.
//!
//! On **desktop** they live in the OS keychain (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service) via the `keyring` crate. On **mobile**
//! the `keyring` crate has no backend, so these are no-ops: nothing is
//! persisted and the connect path simply prompts for the password each time. A
//! real mobile secure store (Android Keystore / iOS Keychain) can replace the
//! mobile impl later — the Tauri command surface stays identical either way.
//!
//! The frontend saves/clears a password when a host is added or edited; the SSH
//! connect path (`ssh::open_authenticated`) reads it back with
//! `load_host_password` so a saved host connects without a prompt.

// ---------------- Desktop: real OS keychain ----------------
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod platform {
    use keyring::{Entry, Error};

    /// Keychain service name. Stable so entries survive restarts; matches the
    /// app's bundle identifier.
    const SERVICE: &str = "com.devstudio.sshmanger";

    fn entry(host_id: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, host_id).map_err(|e| format!("Keychain unavailable: {e}"))
    }

    pub fn save(host_id: &str, password: &str) -> Result<(), String> {
        entry(host_id)?
            .set_password(password)
            .map_err(|e| format!("Could not save password: {e}"))
    }

    pub fn delete(host_id: &str) -> Result<(), String> {
        match entry(host_id)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Could not remove saved password: {e}")),
        }
    }

    pub fn has(host_id: &str) -> Result<bool, String> {
        match entry(host_id)?.get_password() {
            Ok(_) => Ok(true),
            Err(Error::NoEntry) => Ok(false),
            Err(e) => Err(format!("Keychain error: {e}")),
        }
    }

    pub fn load(host_id: &str) -> Option<String> {
        Entry::new(SERVICE, host_id).ok()?.get_password().ok()
    }
}

// ---------------- Mobile: no persistent store (yet) ----------------
#[cfg(any(target_os = "android", target_os = "ios"))]
mod platform {
    // Saving is a no-op so the add/edit flow still completes; connecting then
    // falls back to prompting for the password each time.
    pub fn save(_host_id: &str, _password: &str) -> Result<(), String> {
        Ok(())
    }
    pub fn delete(_host_id: &str) -> Result<(), String> {
        Ok(())
    }
    pub fn has(_host_id: &str) -> Result<bool, String> {
        Ok(false)
    }
    pub fn load(_host_id: &str) -> Option<String> {
        None
    }
}

/// Save (or replace) the password for a host.
#[tauri::command]
pub fn save_host_password(host_id: String, password: String) -> Result<(), String> {
    platform::save(&host_id, &password)
}

/// Remove a host's saved password. A missing entry is not an error.
#[tauri::command]
pub fn delete_host_password(host_id: String) -> Result<(), String> {
    platform::delete(&host_id)
}

/// Whether a host has a saved password (so the UI can show a "saved" hint).
#[tauri::command]
pub fn has_host_password(host_id: String) -> Result<bool, String> {
    platform::has(&host_id)
}

/// Fetch a host's saved password, if any. Used by the connect path; never
/// logged. Returns `None` when nothing is stored or the keychain is unreachable.
pub fn load_host_password(host_id: &str) -> Option<String> {
    platform::load(host_id)
}
