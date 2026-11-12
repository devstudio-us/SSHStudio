//! Import / export of the user's data as a single JSON file.
//!
//! An export contains the chosen hosts and, optionally, the saved commands
//! (global ones plus those scoped to the chosen hosts). It deliberately carries
//! **no secrets** — passwords live in the OS keychain and are never written
//! here, and key contents are never written (see CLAUDE.md). The private-key
//! *path* is also stripped on export, since it's specific to the exporting
//! machine and wouldn't be valid on the system importing the file. Importing is
//! non-destructive: it merges the chosen hosts in, minting fresh ids and
//! skipping entries that already exist.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use tauri::AppHandle;
use tauri_plugin_fs::{FilePath, FsExt};

use crate::hosts::{self, Host};
use crate::notes::{self, Note};

const FORMAT: &str = "sshstudio-backup";
const VERSION: u32 = 1;

/// On-disk shape of an export file.
#[derive(Serialize, Deserialize)]
pub struct Backup {
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

/// Write the chosen hosts (and optionally their + global commands) to `path`.
#[tauri::command]
pub fn export_data(
    app: AppHandle,
    path: String,
    host_ids: Vec<String>,
    include_notes: bool,
) -> Result<(), String> {
    let sel: HashSet<&str> = host_ids.iter().map(|s| s.as_str()).collect();

    // Strip the private-key path: the export carries no secrets, and the key
    // location is a local-machine detail that shouldn't leave this device (same
    // rule as on-disk config — keys are referenced by path only, never copied).
    let hosts: Vec<Host> = hosts::load(&app)?
        .into_iter()
        .filter(|h| sel.contains(h.id.as_str()))
        .map(|mut h| {
            h.identity_file = None;
            h
        })
        .collect();

    let notes: Vec<Note> = if include_notes {
        notes::load(&app)?
            .into_iter()
            .filter(|n| note_in_scope(n, &sel))
            .collect()
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
    let json =
        serde_json::to_string_pretty(&backup).map_err(|e| format!("could not serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("could not write {path}: {e}"))
}

/// Parse a backup file and return it, so the UI can show its hosts/commands for
/// the user to pick which to import. Rejects files that aren't SSHStudio backups.
#[tauri::command]
pub fn read_backup(app: AppHandle, path: String) -> Result<Backup, String> {
    let backup = parse(&app, &path)?;
    Ok(backup)
}

/// Merge the chosen hosts from an export file into the current data.
/// Non-destructive: existing entries are kept, imported ones get new ids, and
/// duplicates are skipped. Host-scoped commands are re-linked via an id remap.
#[tauri::command]
pub fn import_data(
    app: AppHandle,
    path: String,
    host_ids: Vec<String>,
    include_notes: bool,
) -> Result<ImportSummary, String> {
    let backup = parse(&app, &path)?;
    let sel: HashSet<&str> = host_ids.iter().map(|s| s.as_str()).collect();

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
        if !sel.contains(incoming.id.as_str()) {
            continue; // host not chosen for import
        }
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

    // Commands: global ones, plus those scoped to a chosen host.
    if include_notes && !backup.notes.is_empty() {
        let mut notes = notes::load(&app)?;
        for mut incoming in backup.notes {
            if !note_in_scope(&incoming, &sel) {
                continue;
            }
            // Re-point a host-scoped command at its host's id here. If that host
            // wasn't imported/matched, fall back to a global command.
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

/// Read + parse + validate a backup file.
///
/// The file is read through the fs plugin (not `std::fs`) so the path may be a
/// `content://` URI — that's what Android's file picker hands back, and only the
/// plugin's ContentResolver-backed reader can open it. On desktop a plain path
/// takes the same route and reads normally. `FilePath::from_str` is infallible
/// (its error type is the never type), so the parse can't fail here.
fn parse(app: &AppHandle, path: &str) -> Result<Backup, String> {
    let file = FilePath::from_str(path).expect("FilePath::from_str is infallible");
    let text = app
        .fs()
        .read_to_string(file)
        .map_err(|e| format!("could not read {path}: {e}"))?;
    let backup: Backup = serde_json::from_str(&text)
        .map_err(|e| format!("not a valid SSHStudio backup file: {e}"))?;
    if backup.format != FORMAT {
        return Err("this file is not an SSHStudio backup".to_string());
    }
    Ok(backup)
}

/// A command is "in scope" for a selection if it is global or scoped to one of
/// the selected host ids.
fn note_in_scope(n: &Note, sel: &HashSet<&str>) -> bool {
    match &n.host_id {
        None => true,
        Some(h) => sel.contains(h.as_str()),
    }
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
