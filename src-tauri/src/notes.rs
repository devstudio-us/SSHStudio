//! Notes store: saved commands and text snippets, persisted as `notes.toml` in
//! the OS config directory. A note is "runnable" when it has a non-empty
//! `command`; `host_id` scopes it to a host (`None` = global).
//!
//! Same thin shape as the hosts store: serialization + atomic file I/O only.

use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// A saved note. `id` is minted by the backend on `add_note`; everything else
/// is user-supplied. Either `text` or `command` may be empty, but not both
/// (enforced by the UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Free-text note / description.
    #[serde(default)]
    pub text: String,
    /// Runnable command (may be multi-line). Empty = not runnable.
    #[serde(default)]
    pub command: String,
    /// Host this note is scoped to; `None` = global.
    #[serde(default)]
    pub host_id: Option<String>,
}

/// On-disk shape of `notes.toml`: a single `[[notes]]` array of tables.
#[derive(Debug, Default, Serialize, Deserialize)]
struct NotesFile {
    #[serde(default)]
    notes: Vec<Note>,
}

fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("notes.toml"))
}

/// Load all notes. A missing file is treated as an empty list (first run).
fn load(app: &AppHandle) -> Result<Vec<Note>, String> {
    let path = notes_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("could not read {path:?}: {e}"))?;
    let parsed: NotesFile =
        toml::from_str(&text).map_err(|e| format!("could not parse notes.toml: {e}"))?;
    Ok(parsed.notes)
}

/// Persist the full list atomically: temp file -> fsync -> .bak -> rename.
/// Same guarantee as the hosts store: never a half-written notes.toml.
fn save(app: &AppHandle, notes: &[Note]) -> Result<(), String> {
    let path = notes_path(app)?;
    let file = NotesFile {
        notes: notes.to_vec(),
    };
    let text = toml::to_string_pretty(&file).map_err(|e| format!("could not serialize: {e}"))?;

    let tmp = path.with_extension("toml.tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| format!("could not create {tmp:?}: {e}"))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("could not write {tmp:?}: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("could not flush {tmp:?}: {e}"))?;
    }

    if path.exists() {
        let bak = path.with_extension("toml.bak");
        fs::copy(&path, &bak).map_err(|e| format!("could not back up to {bak:?}: {e}"))?;
    }

    fs::rename(&tmp, &path).map_err(|e| format!("could not replace {path:?}: {e}"))
}

#[tauri::command]
pub fn list_notes(app: AppHandle) -> Result<Vec<Note>, String> {
    load(&app)
}

#[tauri::command]
pub fn add_note(app: AppHandle, mut note: Note) -> Result<Note, String> {
    let mut notes = load(&app)?;
    note.id = uuid::Uuid::new_v4().to_string();
    notes.push(note.clone());
    save(&app, &notes)?;
    Ok(note)
}

#[tauri::command]
pub fn update_note(app: AppHandle, note: Note) -> Result<Note, String> {
    let mut notes = load(&app)?;
    let idx = notes
        .iter()
        .position(|n| n.id == note.id)
        .ok_or_else(|| format!("note {} not found", note.id))?;
    notes[idx] = note.clone();
    save(&app, &notes)?;
    Ok(note)
}

#[tauri::command]
pub fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    let mut notes = load(&app)?;
    let before = notes.len();
    notes.retain(|n| n.id != id);
    if notes.len() == before {
        return Err(format!("note {id} not found"));
    }
    save(&app, &notes)
}
