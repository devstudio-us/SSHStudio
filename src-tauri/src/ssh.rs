//! SSH session manager.
//!
//! Opens interactive shell sessions to hosts from the store, verifies the
//! server's host key against `known_hosts.toml` (trust-on-first-use, refuse on
//! mismatch), and bridges the shell's PTY to the frontend: output is streamed
//! as Tauri events, input/resize/close arrive as Tauri commands.
//!
//! The Rust layer stays thin — it only moves bytes. Each live session is driven
//! by one async task that owns the russh channel; the manager keeps an mpsc
//! sender per session so commands can hand work to that task.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use russh::client;
use russh::keys::ssh_key::{Algorithm, HashAlg, PublicKey};
use russh::keys::{PrivateKeyWithHashAlg, load_secret_key};
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::hosts;

/// Work handed to a session's driver task.
enum SessionCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// A session's lifecycle. `connect` leaves it `Pending` with the channel open
/// but unread, so output buffers until the frontend has subscribed and called
/// `attach`, which starts the reader task and moves it to `Running`.
enum SessionState {
    Pending {
        handle: client::Handle<Client>,
        channel: russh::Channel<client::Msg>,
    },
    Running(mpsc::Sender<SessionCommand>),
}

/// Tauri-managed state: a map of session id -> state. Wrapped in an
/// `Arc<Mutex<..>>` so the per-session task can clone the map and remove its own
/// entry when the shell exits.
///
/// `secrets` caches the password/passphrase used for a successful connect,
/// keyed by host id, so the metrics poller can reopen a session without
/// re-prompting. It lives only in memory for the session's lifetime and is
/// never written to disk or logged. Presence of a key also marks a host as
/// "connected at least once this session".
#[derive(Default, Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    secrets: Arc<Mutex<HashMap<String, Option<String>>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Clone the command sender for a session that is running.
    fn sender(&self, id: &str) -> Option<mpsc::Sender<SessionCommand>> {
        match self.sessions.lock().unwrap().get(id) {
            Some(SessionState::Running(tx)) => Some(tx.clone()),
            _ => None,
        }
    }

    /// Remember the secret used to connect to a host this session.
    fn remember_secret(&self, host_id: &str, secret: Option<String>) {
        self.secrets
            .lock()
            .unwrap()
            .insert(host_id.to_string(), secret);
    }

    /// The cached secret for a host: outer `None` means the host has not been
    /// connected this session; `Some(inner)` gives the secret (which may itself
    /// be `None` for an unencrypted key).
    pub fn cached_secret(&self, host_id: &str) -> Option<Option<String>> {
        self.secrets.lock().unwrap().get(host_id).cloned()
    }
}

/// russh client handler. Its only job is host-key verification; russh calls
/// `check_server_key` during the handshake. On rejection we stash a readable
/// reason that `connect` surfaces to the caller.
pub(crate) struct Client {
    /// Identifier used as the known_hosts key, e.g. "example.com:22".
    server_id: String,
    known_hosts_path: PathBuf,
    reject_reason: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let mut known = load_known_hosts(&self.known_hosts_path).unwrap_or_default();

        match known.hosts.get(&self.server_id) {
            // Seen before and unchanged: trust it.
            Some(existing) if *existing == fingerprint => Ok(true),
            // Seen before but the key changed: refuse (possible MITM).
            Some(existing) => {
                *self.reject_reason.lock().unwrap() = Some(format!(
                    "Host key mismatch for {}.\nKnown fingerprint: {}\nServer offered:   {}\n\nIf you trust this change, remove the entry from known_hosts.toml and reconnect.",
                    self.server_id, existing, fingerprint
                ));
                Ok(false)
            }
            // First time: trust on first use and record the fingerprint.
            None => {
                known.hosts.insert(self.server_id.clone(), fingerprint);
                if let Err(e) = save_known_hosts(&self.known_hosts_path, &known) {
                    *self.reject_reason.lock().unwrap() =
                        Some(format!("Could not save host fingerprint: {e}"));
                    return Ok(false);
                }
                Ok(true)
            }
        }
    }
}

/// On-disk shape of `known_hosts.toml`: `[hosts]` then `"host:port" = "SHA256:.."`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct KnownHosts {
    #[serde(default)]
    hosts: HashMap<String, String>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create config dir: {e}"))?;
    Ok(dir)
}

fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("known_hosts.toml"))
}

fn load_known_hosts(path: &PathBuf) -> Result<KnownHosts, String> {
    if !path.exists() {
        return Ok(KnownHosts::default());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    toml::from_str(&text).map_err(|e| e.to_string())
}

fn save_known_hosts(path: &PathBuf, known: &KnownHosts) -> Result<(), String> {
    let text = toml::to_string_pretty(known).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Expand a leading `~/` to the user's home directory. Other paths pass through.
fn resolve_identity_path(app: &AppHandle, raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\"))
        && let Ok(home) = app.path().home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(raw)
}

/// Turn a key-loading error into a message. When the key is encrypted and no
/// secret was supplied, return the `PASSPHRASE_REQUIRED` sentinel so the
/// frontend knows to prompt. Error text is matched (not variant names) to stay
/// resilient across russh/ssh-key versions. Never includes key material.
fn classify_key_error(e: &russh::keys::Error, had_secret: bool) -> String {
    let msg = e.to_string().to_lowercase();
    let looks_encrypted = msg.contains("encrypt") || msg.contains("passphrase");
    if looks_encrypted && !had_secret {
        "PASSPHRASE_REQUIRED".to_string()
    } else if looks_encrypted || msg.contains("decrypt") || msg.contains("crypto") {
        "Incorrect passphrase for identity file.".to_string()
    } else {
        format!("Could not load identity file: {e}")
    }
}

/// Open a TCP+SSH connection to a host, verify its host key, and authenticate.
/// Returns the authenticated session handle; the caller decides what channels
/// to open on it (a shell for `connect`, exec channels for the metrics poller).
///
/// `secret` is the password, or the key passphrase for an identity-file host.
pub(crate) async fn open_authenticated(
    app: &AppHandle,
    host: &crate::hosts::Host,
    secret: Option<&str>,
) -> Result<client::Handle<Client>, String> {
    if host.user.trim().is_empty() {
        return Err("This host has no user set. Edit the host and add one.".to_string());
    }

    let server_id = format!("{}:{}", host.hostname, host.port);
    let reject_reason = Arc::new(Mutex::new(None));
    let handler = Client {
        server_id: server_id.clone(),
        known_hosts_path: known_hosts_path(app)?,
        reject_reason: reject_reason.clone(),
    };

    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, server_id.clone(), handler)
        .await
        .map_err(|e| {
            // A host-key rejection surfaces here as a handshake error; prefer
            // our explicit reason when we recorded one.
            reject_reason
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| format!("Could not connect to {server_id}: {e}"))
        })?;

    let authed = match host.identity_file.as_deref().filter(|s| !s.is_empty()) {
        Some(identity) => {
            let path = resolve_identity_path(app, identity);
            let key = Arc::new(
                load_secret_key(&path, secret)
                    .map_err(|e| classify_key_error(&e, secret.is_some()))?,
            );

            // RSA keys must be offered with an rsa-sha2-256/512 signature;
            // modern OpenSSH rejects the legacy ssh-rsa (SHA-1) algorithm. Ask
            // the server which hash it supports and sign with that. ed25519,
            // ecdsa, etc. ignore the hash, so pass None for them.
            let hash_alg = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
                session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| format!("Authentication error: {e}"))?
                    .flatten()
            } else {
                None
            };

            let key = PrivateKeyWithHashAlg::new(key, hash_alg);
            session
                .authenticate_publickey(&host.user, key)
                .await
                .map_err(|e| format!("Authentication error: {e}"))?
                .success()
        }
        None => {
            let pw = secret.ok_or("PASSWORD_REQUIRED")?;
            session
                .authenticate_password(&host.user, pw)
                .await
                .map_err(|e| format!("Authentication error: {e}"))?
                .success()
        }
    };
    if !authed {
        return Err("Authentication failed.".to_string());
    }

    Ok(session)
}

/// Connect to a host, authenticate, open a shell on a PTY, and start streaming.
///
/// `password` doubles as the key passphrase when the host uses an identity
/// file. Returns the new session id. On a recoverable auth gap it returns the
/// sentinels `PASSWORD_REQUIRED` / `PASSPHRASE_REQUIRED` so the UI can prompt.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, SessionManager>,
    host_id: String,
    password: Option<String>,
) -> Result<String, String> {
    let host = hosts::get_host(&app, &host_id)?.ok_or("Host not found.")?;
    let session = open_authenticated(&app, &host, password.as_deref()).await?;

    // Remember the working secret so the metrics poller can reconnect without
    // prompting. Stored in memory only.
    state.remember_secret(&host_id, password.clone());

    // --- Shell on a PTY ---
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Could not open session channel: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| format!("Could not request PTY: {e}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("Could not start shell: {e}"))?;

    // Hold the session open but unread. The reader starts on `attach`, once
    // the frontend has subscribed to this session's events — so the initial
    // shell banner/prompt is not emitted into the void.
    let session_id = Uuid::new_v4().to_string();
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        SessionState::Pending {
            handle: session,
            channel,
        },
    );

    Ok(session_id)
}

/// Start streaming a session that `connect` left pending. Idempotent: a second
/// call (or one for an unknown/running session) is a no-op.
#[tauri::command]
pub async fn attach(
    app: AppHandle,
    state: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    // Take the pending session out of the map, if it is still pending.
    let pending = {
        let mut map = state.sessions.lock().unwrap();
        match map.remove(&session_id) {
            Some(SessionState::Pending { handle, channel }) => Some((handle, channel)),
            Some(other) => {
                map.insert(session_id.clone(), other); // already running: put it back
                None
            }
            None => None,
        }
    };
    let Some((handle, channel)) = pending else {
        return Ok(());
    };

    let (tx, rx) = mpsc::channel::<SessionCommand>(64);
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), SessionState::Running(tx));

    let sessions = state.sessions.clone();
    tokio::spawn(run_session(
        app.clone(),
        session_id,
        handle,
        channel,
        rx,
        sessions,
    ));
    Ok(())
}

/// Owns the channel for the lifetime of one shell. Reads shell output and
/// forwards it to the frontend; applies input/resize/close commands.
async fn run_session(
    app: AppHandle,
    session_id: String,
    session: client::Handle<Client>,
    mut channel: russh::Channel<client::Msg>,
    mut rx: mpsc::Receiver<SessionCommand>,
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
) {
    let output_event = format!("pty-output-{session_id}");
    let closed_event = format!("pty-closed-{session_id}");

    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = app.emit(&output_event, data.to_vec());
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app.emit(&output_event, data.to_vec());
                    }
                    // Shell exited or channel closed.
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(SessionCommand::Data(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCommand::Close) | None => break,
                }
            }
        }
    }

    // Best-effort clean shutdown, then drop from the manager and notify the UI.
    let _ = session
        .disconnect(Disconnect::ByApplication, "", "")
        .await;
    sessions.lock().unwrap().remove(&session_id);
    let _ = app.emit(&closed_event, ());
}

#[tauri::command]
pub async fn write_pty(
    state: State<'_, SessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let tx = state.sender(&session_id).ok_or("Session is not open.")?;
    tx.send(SessionCommand::Data(data.into_bytes()))
        .await
        .map_err(|_| "Session is closing.".to_string())
}

#[tauri::command]
pub async fn resize_pty(
    state: State<'_, SessionManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let tx = state.sender(&session_id).ok_or("Session is not open.")?;
    tx.send(SessionCommand::Resize { cols, rows })
        .await
        .map_err(|_| "Session is closing.".to_string())
}

#[tauri::command]
pub async fn disconnect(
    state: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    // Remove first so no further commands are accepted, then tear down.
    let removed = state.sessions.lock().unwrap().remove(&session_id);
    match removed {
        Some(SessionState::Running(tx)) => {
            let _ = tx.send(SessionCommand::Close).await;
        }
        Some(SessionState::Pending { handle, .. }) => {
            // Never attached: close the transport directly (channel drops).
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
        }
        None => {}
    }
    Ok(())
}
