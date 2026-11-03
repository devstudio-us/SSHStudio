//! App settings store: a small `settings.toml` in the OS config directory.
//! Like `hosts.rs` this module is intentionally thin — only serialization and
//! file I/O, no product logic. Settings are plain preferences (never secrets).

use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// User preferences persisted across runs. New fields should default so an
/// older `settings.toml` still parses.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Folder SFTP downloads are saved into. `None` until the user picks one,
    /// which is what triggers the first-time "choose a download folder" prompt
    /// in the UI.
    #[serde(default)]
    pub download_dir: Option<String>,
}

/// Resolve `<app config dir>/settings.toml`, creating the directory if needed.
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir.join("settings.toml"))
}

/// Load settings. A missing file is treated as defaults (first run).
fn load(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("could not read {path:?}: {e}"))?;
    toml::from_str(&text).map_err(|e| format!("could not parse settings.toml: {e}"))
}

/// Persist atomically: write a sibling temp file, flush it, then rename over the
/// target so a crash can never leave a half-written settings.toml.
fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = toml::to_string_pretty(settings).map_err(|e| format!("could not serialize: {e}"))?;

    let tmp = path.with_extension("toml.tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| format!("could not create {tmp:?}: {e}"))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("could not write {tmp:?}: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("could not flush {tmp:?}: {e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("could not replace {path:?}: {e}"))
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    load(&app)
}

/// Save the SFTP download folder. An empty string clears it (back to "ask").
#[tauri::command]
pub fn set_download_dir(app: AppHandle, dir: String) -> Result<Settings, String> {
    let mut settings = load(&app)?;
    settings.download_dir = if dir.trim().is_empty() { None } else { Some(dir) };
    save(&app, &settings)?;
    Ok(settings)
}
