//! Import / export of the user's data as a single JSON file.
//!
//! An export always contains the hosts and, optionally, the saved commands
//! (notes). It deliberately carries **no secrets** — passwords live in the OS
//! keychain and are never written here, and private keys are referenced by
//! path only (same rule as the on-disk config, see CLAUDE.md). Importing is
//! non-destructive: it merges into the existing data, minting fresh ids and
//! skipping entries that already exist.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;

use crate::hosts::{self, Host};
use crate::notes::{self, Note};

const FORMAT: &str = "sshstudio-backup";
const VERSION: u32 = 1;

/// On-disk shape of an export file.
#[derive(Serialize, Deserialize)]
struct Backup {
    /// Marker so import can reject unrelated JSON files.
    format: String,
    version: u32,
    /// Version of the app that produced the file (informational).
    #[serde(default)]
    app_version: String,
    hosts: Vec<Host>,
    /// Empty when the user exported without commands.
    #[serde(default)]
    notes: Vec<Note>,
}

/// Counts returned to the UI after an import.
#[derive(Serialize)]
pub struct ImportSummary {
    pub hosts_added: usize,
    pub hosts_skipped: usize,
    pub notes_added: usize,
    pub notes_skipped: usize,
}

/// Write all hosts (and optionally commands) to `path` as JSON.
#[tauri::command]
pub fn export_data(app: AppHandle, path: String, include_notes: bool) -> Result<(), String> {
    let hosts = hosts::load(&app)?;
    let notes = if include_notes {
        notes::load(&app)?
    } else {
        Vec::new()
    };
    let backup = Backup {
        format: FORMAT.to_string(),
        version: VERSION,
        app_version: app.package_info().version.to_string(),
        hosts,
        notes,
    };
    let json = serde_json::to_string_pretty(&backup).map_err(|e| format!("could not serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("could not write {path}: {e}"))
}

/// Merge an export file into the current data. Non-destructive: existing
/// entries are kept, imported ones get new ids, and duplicates are skipped.
/// Host-scoped commands are re-linked to the right host via an id remap.
#[tauri::command]
pub fn import_data(app: AppHandle, path: String) -> Result<ImportSummary, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    let backup: Backup = serde_json::from_str(&text)
        .map_err(|e| format!("not a valid SSHStudio backup file: {e}"))?;
    if backup.format != FORMAT {
        return Err("this file is not an SSHStudio backup".to_string());
    }

    let mut hosts = hosts::load(&app)?;
    let mut summary = ImportSummary {
        hosts_added: 0,
        hosts_skipped: 0,
        notes_added: 0,
        notes_skipped: 0,
    };

    // Map each imported host's old id to the id it ends up under here, so the
    // commands that reference it can be re-pointed. A skipped duplicate maps to
    // the existing host's id.
    let mut id_map: HashMap<String, String> = HashMap::new();

    for mut incoming in backup.hosts {
        let old_id = incoming.id.clone();
        if let Some(existing) = hosts.iter().find(|h| same_host(h, &incoming)) {
            id_map.insert(old_id, existing.id.clone());
            summary.hosts_skipped += 1;
            continue;
        }
        let new_id = uuid::Uuid::new_v4().to_string();
        incoming.id = new_id.clone();
        if !old_id.is_empty() {
            id_map.insert(old_id, new_id);
        }
        hosts.push(incoming);
        summary.hosts_added += 1;
    }

    if summary.hosts_added > 0 {
        hosts::save(&app, &hosts)?;
    }

    // Commands (only present when the export included them).
    if !backup.notes.is_empty() {
        let mut notes = notes::load(&app)?;
        for mut incoming in backup.notes {
            // Re-point a host-scoped command at its host's id here. If that host
            // wasn't imported/matched, fall back to a global command rather than
            // leaving it orphaned.
            incoming.host_id = match incoming.host_id {
                Some(hid) => id_map.get(&hid).cloned(),
                None => None,
            };
            if notes.iter().any(|n| same_note(n, &incoming)) {
                summary.notes_skipped += 1;
                continue;
            }
            incoming.id = uuid::Uuid::new_v4().to_string();
            notes.push(incoming);
            summary.notes_added += 1;
        }
        if summary.notes_added > 0 {
            notes::save(&app, &notes)?;
        }
    }

    Ok(summary)
}

/// Two hosts are "the same" connection if user@hostname:port matches
/// (case-insensitive on hostname/user). Name/tags/notes may differ.
fn same_host(a: &Host, b: &Host) -> bool {
    a.port == b.port
        && a.hostname.eq_ignore_ascii_case(&b.hostname)
        && a.user.eq_ignore_ascii_case(&b.user)
}

/// Two commands are duplicates if their scope and content match.
fn same_note(a: &Note, b: &Note) -> bool {
    a.host_id == b.host_id && a.name == b.name && a.command == b.command && a.text == b.text
}
