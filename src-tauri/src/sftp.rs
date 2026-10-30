//! SFTP file browsing and transfers, layered on the SSH connection code in
//! `ssh.rs`. Each host gets its own SFTP session, authenticated with the secret
//! cached by `connect` (so opening Files for a connected host needs no prompt).
//!
//! A `tauri::command` here is a function the Angular frontend calls over IPC
//! via `invoke("name", { args })`. Remote paths are POSIX ("/"); local paths
//! are whatever the OS uses (e.g. "C:\\…" on Windows).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use russh::client;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::hosts;
use crate::ssh::{Client, SessionManager};

/// One SFTP session for a host. The SSH handle is held (not used directly) so
/// the underlying connection stays alive for as long as the SFTP session does.
struct SftpConn {
    _handle: Arc<client::Handle<Client>>,
    sftp: SftpSession,
}

/// Tauri-managed state: one SFTP session per host id, opened on demand.
#[derive(Default)]
pub struct SftpManager {
    conns: Mutex<HashMap<String, Arc<SftpConn>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, host_id: &str) -> Option<Arc<SftpConn>> {
        self.conns.lock().unwrap().get(host_id).cloned()
    }
}

/// A file or directory entry, used for both panes (local and remote).
#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// Last-modified time as a Unix timestamp (seconds), if known.
    modified: Option<u64>,
}

/// Progress update for a transfer, emitted as `sftp-progress-<transfer_id>`.
#[derive(Clone, Serialize)]
struct Progress {
    transferred: u64,
    total: u64,
}

/// Get the host's SFTP session, opening (and caching) one if needed. Uses the
/// secret cached by `connect`, so no prompt is shown for a connected host.
async fn session_for(
    app: &AppHandle,
    ssh: &SessionManager,
    sftp: &SftpManager,
    host_id: &str,
) -> Result<Arc<SftpConn>, String> {
    if let Some(conn) = sftp.get(host_id) {
        return Ok(conn);
    }

    let host = hosts::get_host(app, host_id)?.ok_or("Host not found.")?;
    // `cached_secret` outer None => never connected this session.
    let secret = ssh
        .cached_secret(host_id)
        .ok_or("Connect to this host first, then open its files.")?;

    let handle = Arc::new(crate::ssh::open_authenticated(app, &host, secret.as_deref()).await?);
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Could not open SFTP channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Server refused SFTP: {e}"))?;
    let session = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("Could not start SFTP: {e}"))?;

    let conn = Arc::new(SftpConn {
        _handle: handle,
        sftp: session,
    });
    // Reuse an entry a concurrent call may have inserted while we connected.
    let mut map = sftp.conns.lock().unwrap();
    Ok(map.entry(host_id.to_string()).or_insert(conn).clone())
}

/// Join a POSIX directory path and an entry name.
fn remote_join(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", dir.trim_end_matches('/'))
    }
}

// ---- Remote (SFTP) commands ----

/// The host's default directory (its home), used as the starting path.
#[tauri::command]
pub async fn sftp_home(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
) -> Result<String, String> {
    let conn = session_for(&app, &ssh, &sftp, &host_id).await?;
    conn.sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("Could not resolve home directory: {e}"))
}

/// List a remote directory.
#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let conn = session_for(&app, &ssh, &sftp, &host_id).await?;
    let read = conn
        .sftp
        .read_dir(path.as_str())
        .await
        .map_err(|e| format!("Could not list {path}: {e}"))?;

    let mut entries: Vec<FileEntry> = read
        .map(|e| {
            let meta = e.metadata();
            let name = e.file_name();
            FileEntry {
                path: remote_join(&path, &name),
                name,
                is_dir: meta.is_dir(),
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.map(|t| t as u64),
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
    sort_entries(&mut entries);
    Ok(entries)
}

#[tauri::command]
pub async fn sftp_mkdir(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    path: String,
) -> Result<(), String> {
    let conn = session_for(&app, &ssh, &sftp, &host_id).await?;
    conn.sftp
        .create_dir(path)
        .await
        .map_err(|e| format!("Could not create folder: {e}"))
}

#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let conn = session_for(&app, &ssh, &sftp, &host_id).await?;
    conn.sftp
        .rename(from, to)
        .await
        .map_err(|e| format!("Could not rename: {e}"))
}

#[tauri::command]
pub async fn sftp_delete(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let conn = session_for(&app, &ssh, &sftp, &host_id).await?;
    let res = if is_dir {
        conn.sftp.remove_dir(path).await
    } else {
        conn.sftp.remove_file(path).await
    };
    res.map_err(|e| format!("Could not delete: {e}"))
}

/// Download a remote file to a local path, emitting progress.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let conn = session_for(&app, &ssh, &sftp, &host_id).await?;
    let total = conn
        .sftp
        .metadata(remote_path.as_str())
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);

    let mut remote = conn
        .sftp
        .open(remote_path.as_str())
        .await
        .map_err(|e| format!("Could not open remote file: {e}"))?;
    let mut local = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("Could not create local file: {e}"))?;

    copy_with_progress(&app, &transfer_id, &mut remote, &mut local, total).await?;
    local
        .flush()
        .await
        .map_err(|e| format!("Could not finish download: {e}"))
}

/// Upload a local file to a remote path, emitting progress.
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let conn = session_for(&app, &ssh, &sftp, &host_id).await?;
    let mut local = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("Could not open local file: {e}"))?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut remote = conn
        .sftp
        .create(remote_path.as_str())
        .await
        .map_err(|e| format!("Could not create remote file: {e}"))?;

    copy_with_progress(&app, &transfer_id, &mut local, &mut remote, total).await?;
    remote
        .shutdown()
        .await
        .map_err(|e| format!("Could not finish upload: {e}"))
}

/// Close and forget a host's SFTP session (e.g. when its Files view is closed).
#[tauri::command]
pub fn sftp_disconnect(sftp: State<'_, SftpManager>, host_id: String) {
    sftp.conns.lock().unwrap().remove(&host_id);
}

/// Stream `reader` into `writer` in chunks, emitting throttled progress.
async fn copy_with_progress<R, W>(
    app: &AppHandle,
    transfer_id: &str,
    reader: &mut R,
    writer: &mut W,
    total: u64,
) -> Result<(), String>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let event = format!("sftp-progress-{transfer_id}");
    let mut buf = vec![0u8; 64 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("Transfer read error: {e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("Transfer write error: {e}"))?;
        transferred += n as u64;
        // Emit at most every ~512 KiB to avoid flooding the frontend.
        if transferred - last_emit >= 512 * 1024 {
            last_emit = transferred;
            let _ = app.emit(&event, Progress { transferred, total });
        }
    }
    // Final 100% update.
    let _ = app.emit(
        &event,
        Progress {
            transferred,
            total: total.max(transferred),
        },
    );
    Ok(())
}

// ---- Local filesystem commands (for the left pane) ----

/// The local home directory as the starting path.
#[tauri::command]
pub fn local_home() -> Result<String, String> {
    dirs_home().ok_or_else(|| "Could not find your home directory.".to_string())
}

/// List a local directory.
#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<FileEntry>, String> {
    let read = std::fs::read_dir(&path).map_err(|e| format!("Could not list {path}: {e}"))?;
    let mut entries = Vec::new();
    for item in read.flatten() {
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        entries.push(FileEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
        });
    }
    sort_entries(&mut entries);
    Ok(entries)
}

/// Home directory without pulling in an extra crate: `$HOME`, or on Windows
/// `%USERPROFILE%` (or `%HOMEDRIVE%%HOMEPATH%`).
fn dirs_home() -> Option<String> {
    if let Ok(h) = std::env::var("HOME")
        && !h.is_empty()
    {
        return Some(h);
    }
    if let Ok(up) = std::env::var("USERPROFILE")
        && !up.is_empty()
    {
        return Some(up);
    }
    match (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        (Ok(d), Ok(p)) if !d.is_empty() => Some(format!("{d}{p}")),
        _ => None,
    }
}

/// Directories first, then files, each alphabetical (case-insensitive).
fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}
