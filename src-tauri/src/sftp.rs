//! SFTP file browsing and transfers, layered on the SSH connection code in
//! `ssh.rs`. Each host gets its own SFTP session, authenticated with the secret
//! cached by `connect` (so opening Files for a connected host needs no prompt).
//!
//! A `tauri::command` here is a function the Angular frontend calls over IPC
//! via `invoke("name", { args })`. Remote paths are POSIX ("/"); local paths
//! are whatever the OS uses (e.g. "C:\\…" on Windows).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

    /// Forget a host's cached session (e.g. after it was found to be dead), so
    /// the next `session_for` opens a fresh one.
    fn evict(&self, host_id: &str) {
        self.conns.lock().unwrap().remove(host_id);
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

/// Run an SFTP operation against the host's session, transparently reopening a
/// session that has gone stale (e.g. the server dropped an idle connection) and
/// retrying the operation once. `op` is `Fn` — callable twice — so it must
/// borrow its inputs rather than consume them.
async fn with_session<F, Fut, T>(
    app: &AppHandle,
    ssh: &SessionManager,
    sftp: &SftpManager,
    host_id: &str,
    op: F,
) -> Result<T, String>
where
    F: Fn(Arc<SftpConn>) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let conn = session_for(app, ssh, sftp, host_id).await?;
    match op(conn).await {
        Err(e) if is_stale_session(&e) => {
            // The cached session (or its SSH transport) is dead; drop it and
            // open a fresh one, then try the operation one more time.
            sftp.evict(host_id);
            let conn = session_for(app, ssh, sftp, host_id).await?;
            op(conn).await
        }
        result => result,
    }
}

/// Whether an error means the SFTP session (or its SSH transport) has died, so
/// reopening it is worth a try. russh-sftp reports a dropped worker as the text
/// "session closed"; a broken transport surfaces as an EOF / reset I/O error.
fn is_stale_session(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("session closed")
        || m.contains("channel closed")
        || m.contains("early eof")
        || m.contains("unexpected eof")
        || m.contains("connection reset")
        || m.contains("broken pipe")
        || m.contains("not connected")
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
    with_session(&app, &ssh, &sftp, &host_id, |conn| async move {
        conn.sftp
            .canonicalize(".")
            .await
            .map_err(|e| format!("Could not resolve home directory: {e}"))
    })
    .await
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
    let path = path.as_str();
    with_session(&app, &ssh, &sftp, &host_id, |conn| async move {
        let read = conn
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("Could not list {path}: {e}"))?;

        let mut entries: Vec<FileEntry> = read
            .map(|e| {
                let meta = e.metadata();
                let name = e.file_name();
                FileEntry {
                    path: remote_join(path, &name),
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
    })
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    path: String,
) -> Result<(), String> {
    let path = path.as_str();
    with_session(&app, &ssh, &sftp, &host_id, |conn| async move {
        conn.sftp
            .create_dir(path)
            .await
            .map_err(|e| format!("Could not create folder: {e}"))
    })
    .await
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
    let (from, to) = (from.as_str(), to.as_str());
    with_session(&app, &ssh, &sftp, &host_id, |conn| async move {
        conn.sftp
            .rename(from, to)
            .await
            .map_err(|e| format!("Could not rename: {e}"))
    })
    .await
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
    let path = path.as_str();
    with_session(&app, &ssh, &sftp, &host_id, |conn| async move {
        let res = if is_dir {
            conn.sftp.remove_dir(path).await
        } else {
            conn.sftp.remove_file(path).await
        };
        res.map_err(|e| format!("Could not delete: {e}"))
    })
    .await
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
    let app = &app;
    let (remote_path, local_path, transfer_id) =
        (remote_path.as_str(), local_path.as_str(), transfer_id.as_str());
    with_session(app, &ssh, &sftp, &host_id, |conn| async move {
        let total = conn
            .sftp
            .metadata(remote_path)
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0);

        let mut remote = conn
            .sftp
            .open(remote_path)
            .await
            .map_err(|e| format!("Could not open remote file: {e}"))?;
        let mut local = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| format!("Could not create local file: {e}"))?;

        let mut prog = ProgressEmitter::new(app, transfer_id, total);
        stream_copy(&mut prog, &mut remote, &mut local).await?;
        local
            .flush()
            .await
            .map_err(|e| format!("Could not finish download: {e}"))?;
        prog.finish();
        Ok(())
    })
    .await
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
    let app = &app;
    let (local_path, remote_path, transfer_id) =
        (local_path.as_str(), remote_path.as_str(), transfer_id.as_str());
    with_session(app, &ssh, &sftp, &host_id, |conn| async move {
        let mut local = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| format!("Could not open local file: {e}"))?;
        let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);
        let mut remote = conn
            .sftp
            .create(remote_path)
            .await
            .map_err(|e| format!("Could not create remote file: {e}"))?;

        let mut prog = ProgressEmitter::new(app, transfer_id, total);
        stream_copy(&mut prog, &mut local, &mut remote).await?;
        remote
            .shutdown()
            .await
            .map_err(|e| format!("Could not finish upload: {e}"))?;
        prog.finish();
        Ok(())
    })
    .await
}

/// Upload a local folder (recursively) to the server, emitting combined
/// progress across all its files as a single `sftp-progress-<transfer_id>`.
#[tauri::command]
pub async fn sftp_upload_dir(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let app = &app;
    let (local_path, remote_path, transfer_id) =
        (local_path.as_str(), remote_path.as_str(), transfer_id.as_str());
    with_session(app, &ssh, &sftp, &host_id, |conn| async move {
        // Walk the local tree first (metadata only) so we know the directories
        // to create and the total byte count for the progress bar.
        let mut files: Vec<(PathBuf, String, u64)> = Vec::new();
        let mut dirs: Vec<String> = Vec::new();
        walk_local(Path::new(local_path), remote_path, &mut files, &mut dirs)?;
        let total: u64 = files.iter().map(|(_, _, size)| size).sum();

        // Create the destination folders (parents first). Ignore errors here:
        // the folder usually already exists when overwriting, and a genuine
        // problem surfaces when the file create below fails.
        for dir in &dirs {
            let _ = conn.sftp.create_dir(dir.as_str()).await;
        }

        let mut prog = ProgressEmitter::new(app, transfer_id, total);
        for (src, dest, _) in &files {
            let mut local = tokio::fs::File::open(src)
                .await
                .map_err(|e| format!("Could not open {}: {e}", src.display()))?;
            let mut remote = conn
                .sftp
                .create(dest.as_str())
                .await
                .map_err(|e| format!("Could not create remote file: {e}"))?;
            stream_copy(&mut prog, &mut local, &mut remote).await?;
            remote
                .shutdown()
                .await
                .map_err(|e| format!("Could not finish upload: {e}"))?;
        }
        prog.finish();
        Ok(())
    })
    .await
}

/// Download a remote folder (recursively) to the local disk, emitting combined
/// progress across all its files as a single `sftp-progress-<transfer_id>`.
#[tauri::command]
pub async fn sftp_download_dir(
    app: AppHandle,
    ssh: State<'_, SessionManager>,
    sftp: State<'_, SftpManager>,
    host_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let app = &app;
    let (remote_path, local_path, transfer_id) =
        (remote_path.as_str(), local_path.as_str(), transfer_id.as_str());
    with_session(app, &ssh, &sftp, &host_id, |conn| async move {
        // Walk the remote tree first so we know the folders to create locally
        // and the total byte count for the progress bar.
        let mut files: Vec<(String, PathBuf, u64)> = Vec::new();
        let mut dirs: Vec<PathBuf> = Vec::new();
        walk_remote(&conn.sftp, remote_path, Path::new(local_path), &mut files, &mut dirs).await?;
        let total: u64 = files.iter().map(|(_, _, size)| size).sum();

        for dir in &dirs {
            std::fs::create_dir_all(dir).map_err(|e| format!("Could not create local folder: {e}"))?;
        }

        let mut prog = ProgressEmitter::new(app, transfer_id, total);
        for (src, dest, _) in &files {
            let mut remote = conn
                .sftp
                .open(src.as_str())
                .await
                .map_err(|e| format!("Could not open remote file: {e}"))?;
            let mut local = tokio::fs::File::create(dest)
                .await
                .map_err(|e| format!("Could not create local file: {e}"))?;
            stream_copy(&mut prog, &mut remote, &mut local).await?;
            local
                .flush()
                .await
                .map_err(|e| format!("Could not finish download: {e}"))?;
        }
        prog.finish();
        Ok(())
    })
    .await
}

/// Recursively collect a local tree: `files` as (source path, remote dest path,
/// size) and `dirs` as remote directories to create (parents before children).
fn walk_local(
    dir: &Path,
    remote_dir: &str,
    files: &mut Vec<(PathBuf, String, u64)>,
    dirs: &mut Vec<String>,
) -> Result<(), String> {
    dirs.push(remote_dir.to_string());
    let read = std::fs::read_dir(dir).map_err(|e| format!("Could not read {}: {e}", dir.display()))?;
    for entry in read.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        // Follow junctions so nested folders recurse (see `local_list`).
        let meta = match std::fs::metadata(&path).or_else(|_| entry.metadata()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let remote_child = remote_join(remote_dir, &name);
        if meta.is_dir() {
            walk_local(&path, &remote_child, files, dirs)?;
        } else {
            files.push((path, remote_child, meta.len()));
        }
    }
    Ok(())
}

/// Recursively collect a remote tree: `files` as (remote path, local dest path,
/// size) and `dirs` as local directories to create (parents before children).
async fn walk_remote(
    sftp: &SftpSession,
    remote_dir: &str,
    local_dir: &Path,
    files: &mut Vec<(String, PathBuf, u64)>,
    dirs: &mut Vec<PathBuf>,
) -> Result<(), String> {
    dirs.push(local_dir.to_path_buf());
    let read = sftp
        .read_dir(remote_dir)
        .await
        .map_err(|e| format!("Could not list {remote_dir}: {e}"))?;
    for entry in read {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let remote_child = remote_join(remote_dir, &name);
        let local_child = local_dir.join(&name);
        if meta.is_dir() {
            // Box the recursive future so the async fn has a known size.
            Box::pin(walk_remote(sftp, &remote_child, &local_child, files, dirs)).await?;
        } else {
            files.push((remote_child, local_child, meta.size.unwrap_or(0)));
        }
    }
    Ok(())
}

/// Close and forget a host's SFTP session (e.g. when its Files view is closed).
#[tauri::command]
pub fn sftp_disconnect(sftp: State<'_, SftpManager>, host_id: String) {
    sftp.conns.lock().unwrap().remove(&host_id);
}

/// Tracks cumulative bytes for one transfer (which spans many files when a whole
/// folder is transferred) and emits throttled `sftp-progress-<id>` updates.
struct ProgressEmitter<'a> {
    app: &'a AppHandle,
    event: String,
    transferred: u64,
    last_emit: u64,
    total: u64,
}

impl<'a> ProgressEmitter<'a> {
    fn new(app: &'a AppHandle, transfer_id: &str, total: u64) -> Self {
        Self {
            app,
            event: format!("sftp-progress-{transfer_id}"),
            transferred: 0,
            last_emit: 0,
            total,
        }
    }

    /// Count `n` more bytes and emit at most every ~512 KiB (to avoid flooding).
    fn add(&mut self, n: u64) {
        self.transferred += n;
        if self.transferred - self.last_emit >= 512 * 1024 {
            self.last_emit = self.transferred;
            let _ = self.app.emit(
                &self.event,
                Progress {
                    transferred: self.transferred,
                    total: self.total,
                },
            );
        }
    }

    /// Emit a final update marking the transfer complete.
    fn finish(&self) {
        let _ = self.app.emit(
            &self.event,
            Progress {
                transferred: self.transferred,
                total: self.total.max(self.transferred),
            },
        );
    }
}

/// Stream `reader` into `writer` in chunks, updating `prog` as it goes.
async fn stream_copy<R, W>(
    prog: &mut ProgressEmitter<'_>,
    reader: &mut R,
    writer: &mut W,
) -> Result<(), String>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut buf = vec![0u8; 64 * 1024];
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
        prog.add(n as u64);
    }
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
        let path = item.path();
        // `DirEntry::metadata` does not follow reparse points, so Windows
        // profile junctions (Templates, My Documents, SendTo, …) would show as
        // 0-byte files and be mistaken for uploadable files. Resolve through the
        // link so real folders list as folders; fall back to the entry's own
        // metadata for links we can't follow (some are ACL-protected).
        let meta = match std::fs::metadata(&path).or_else(|_| item.metadata()) {
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
            path: path.to_string_lossy().into_owned(),
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
