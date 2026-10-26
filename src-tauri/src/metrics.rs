//! Per-host metrics poller.
//!
//! For each host the user has connected to this session, `start_metrics` opens
//! a *separate* SSH session (reusing the cached auth) and runs one shell command
//! every 5 seconds to collect CPU / memory / disk / load / uptime. The output is
//! parsed into [`HostMetrics`] and emitted as a `metrics-<host_id>` event.
//!
//! Parsing is deliberately lenient: hosts without `/proc` or `free` (FreeBSD,
//! macOS, …) simply leave those fields `null` ("n/a" in the UI) instead of
//! failing the whole poll.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use russh::client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use crate::hosts;
use crate::ssh::{self, Client, SessionManager};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

/// One command, run on the remote shell. Each section is marked so the parser
/// can pick out what exists; missing tools are silenced (`2>/dev/null`) and the
/// section is simply left empty -> "n/a". CPU is sampled twice a second apart so
/// a usage percentage can be computed from the delta.
const METRICS_COMMAND: &str = "echo __CPU__; grep '^cpu ' /proc/stat 2>/dev/null; sleep 1; grep '^cpu ' /proc/stat 2>/dev/null; \
echo __MEM__; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null; \
echo __DISK__; df -kP / 2>/dev/null | awk 'NR==2{print $2, $3}'; \
echo __LOAD__; cat /proc/loadavg 2>/dev/null || uptime 2>/dev/null; \
echo __UP__; cat /proc/uptime 2>/dev/null; echo __END__";

/// A snapshot of a host's vitals. Every field is optional: `None` renders as
/// "n/a". `error` is set when the whole poll failed (e.g. connection dropped).
#[derive(Debug, Default, Clone, Serialize)]
pub struct HostMetrics {
    cpu_percent: Option<f64>,
    mem_used: Option<u64>,
    mem_total: Option<u64>,
    disk_used: Option<u64>,
    disk_total: Option<u64>,
    load1: Option<f64>,
    load5: Option<f64>,
    load15: Option<f64>,
    uptime_secs: Option<u64>,
    error: Option<String>,
}

/// Tauri-managed state: one stop-sender per running poller, keyed by host id.
/// Dropping the sender (via `stop_metrics` or clearing the map) ends the task.
#[derive(Default, Clone)]
pub struct MetricsManager {
    pollers: Arc<Mutex<HashMap<String, mpsc::Sender<()>>>>,
}

impl MetricsManager {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub fn start_metrics(
    app: AppHandle,
    sessions: State<'_, SessionManager>,
    metrics: State<'_, MetricsManager>,
    host_id: String,
) -> Result<(), String> {
    // Only poll hosts connected at least once this session (so we have auth).
    let secret = sessions
        .cached_secret(&host_id)
        .ok_or("Connect to this host before starting metrics.")?;

    let host = hosts::get_host(&app, &host_id)?.ok_or("Host not found.")?;

    let mut pollers = metrics.pollers.lock().unwrap();
    if pollers.contains_key(&host_id) {
        return Ok(()); // already polling
    }

    let (stop_tx, stop_rx) = mpsc::channel::<()>(1);
    pollers.insert(host_id.clone(), stop_tx);
    tokio::spawn(run_poller(app.clone(), host, secret, stop_rx));
    Ok(())
}

#[tauri::command]
pub fn stop_metrics(metrics: State<'_, MetricsManager>, host_id: String) -> Result<(), String> {
    // Dropping the stored sender signals the task to stop on its next select.
    metrics.pollers.lock().unwrap().remove(&host_id);
    Ok(())
}

/// Poll loop for one host. Emits a snapshot immediately, then every 5s, until
/// the stop sender is dropped.
async fn run_poller(
    app: AppHandle,
    host: hosts::Host,
    secret: Option<String>,
    mut stop: mpsc::Receiver<()>,
) {
    let event = format!("metrics-{}", host.id);
    let mut handle: Option<client::Handle<Client>> = None;

    loop {
        let snapshot = poll_once(&app, &host, secret.as_deref(), &mut handle).await;
        let _ = app.emit(&event, snapshot);

        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
            _ = stop.recv() => break,
        }
    }
}

/// Run one poll, reconnecting if needed. On any failure the handle is dropped so
/// the next tick reconnects, and the error is reported in the snapshot.
async fn poll_once(
    app: &AppHandle,
    host: &hosts::Host,
    secret: Option<&str>,
    handle: &mut Option<client::Handle<Client>>,
) -> HostMetrics {
    if handle.is_none() {
        match ssh::open_authenticated(app, host, secret).await {
            Ok(h) => *handle = Some(h),
            Err(e) => {
                return HostMetrics {
                    error: Some(e),
                    ..Default::default()
                };
            }
        }
    }

    let session = handle.as_mut().unwrap();
    match tokio::time::timeout(COMMAND_TIMEOUT, run_command(session)).await {
        Ok(Ok(output)) => parse_metrics(&output),
        Ok(Err(e)) => {
            *handle = None; // force reconnect next tick
            HostMetrics {
                error: Some(e),
                ..Default::default()
            }
        }
        Err(_) => {
            *handle = None;
            HostMetrics {
                error: Some("Metrics command timed out.".to_string()),
                ..Default::default()
            }
        }
    }
}

/// Open an exec channel, run the metrics command, and collect its stdout.
async fn run_command(session: &mut client::Handle<Client>) -> Result<String, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("channel open failed: {e}"))?;
    channel
        .exec(true, METRICS_COMMAND)
        .await
        .map_err(|e| format!("exec failed: {e}"))?;

    let mut out: Vec<u8> = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            // Ignore stderr and status; we only need stdout.
            Some(ChannelMsg::ExtendedData { .. })
            | Some(ChannelMsg::ExitStatus { .. })
            | Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Split the marked command output into (CPU, MEM, DISK, LOAD, UP) sections and
/// parse each independently so a missing one only nulls its own fields.
fn parse_metrics(text: &str) -> HostMetrics {
    let mut section = "";
    let mut cpu: Vec<String> = Vec::new();
    let mut mem: Vec<String> = Vec::new();
    let mut disk: Vec<String> = Vec::new();
    let mut load: Vec<String> = Vec::new();
    let mut up: Vec<String> = Vec::new();

    for line in text.lines() {
        match line.trim() {
            "__CPU__" => section = "cpu",
            "__MEM__" => section = "mem",
            "__DISK__" => section = "disk",
            "__LOAD__" => section = "load",
            "__UP__" => section = "up",
            "__END__" => section = "",
            other if !other.is_empty() => match section {
                "cpu" => cpu.push(other.to_string()),
                "mem" => mem.push(other.to_string()),
                "disk" => disk.push(other.to_string()),
                "load" => load.push(other.to_string()),
                "up" => up.push(other.to_string()),
                _ => {}
            },
            _ => {}
        }
    }

    let cpu_percent = parse_cpu(&cpu);
    let (mem_used, mem_total) = parse_mem(&mem);
    let (disk_used, disk_total) = parse_disk(&disk);
    let (load1, load5, load15) = parse_load(&load);
    let uptime_secs = parse_uptime(&up);

    HostMetrics {
        cpu_percent,
        mem_used,
        mem_total,
        disk_used,
        disk_total,
        load1,
        load5,
        load15,
        uptime_secs,
        error: None,
    }
}

/// CPU% from two `/proc/stat` "cpu" lines: busy delta over total delta.
fn parse_cpu(lines: &[String]) -> Option<f64> {
    if lines.len() < 2 {
        return None;
    }
    let sample = |line: &str| -> Option<(u64, u64)> {
        // "cpu user nice system idle iowait irq softirq steal ..."
        let nums: Vec<u64> = line
            .split_whitespace()
            .skip(1)
            .filter_map(|t| t.parse().ok())
            .collect();
        if nums.len() < 5 {
            return None;
        }
        let total: u64 = nums.iter().sum();
        let idle = nums[3] + nums[4]; // idle + iowait
        Some((total, idle))
    };
    let (t1, i1) = sample(&lines[0])?;
    let (t2, i2) = sample(&lines[lines.len() - 1])?;
    let dt = t2.checked_sub(t1)?;
    let di = i2.checked_sub(i1)?;
    if dt == 0 {
        return None;
    }
    let busy = dt.saturating_sub(di) as f64;
    Some((busy / dt as f64 * 100.0).clamp(0.0, 100.0))
}

/// Memory used/total in bytes from `/proc/meminfo` (values are in kB).
fn parse_mem(lines: &[String]) -> (Option<u64>, Option<u64>) {
    let mut total_kb = None;
    let mut avail_kb = None;
    for line in lines {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("");
        let value: Option<u64> = parts.next().and_then(|v| v.parse().ok());
        match key {
            "MemTotal:" => total_kb = value,
            "MemAvailable:" => avail_kb = value,
            _ => {}
        }
    }
    match (total_kb, avail_kb) {
        (Some(t), Some(a)) => (Some(t.saturating_sub(a) * 1024), Some(t * 1024)),
        (Some(t), None) => (None, Some(t * 1024)),
        _ => (None, None),
    }
}

/// Disk used/total in bytes for `/` from `df -kP` (values are 1024-byte blocks).
fn parse_disk(lines: &[String]) -> (Option<u64>, Option<u64>) {
    let Some(line) = lines.first() else {
        return (None, None);
    };
    let nums: Vec<u64> = line
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    // We printed "<total> <used>".
    if nums.len() >= 2 {
        (Some(nums[1] * 1024), Some(nums[0] * 1024))
    } else {
        (None, None)
    }
}

/// Load averages from `/proc/loadavg` ("a b c ...") or `uptime` text
/// ("... load average[s]: a, b, c").
fn parse_load(lines: &[String]) -> (Option<f64>, Option<f64>, Option<f64>) {
    let Some(line) = lines.first() else {
        return (None, None, None);
    };

    // Fast path: the line starts with three floats (/proc/loadavg).
    let head: Vec<f64> = line
        .split_whitespace()
        .take(3)
        .filter_map(|t| t.parse().ok())
        .collect();
    if head.len() == 3 {
        return (Some(head[0]), Some(head[1]), Some(head[2]));
    }

    // Fallback: find "average" and read the three numbers after it.
    if let Some(idx) = line.to_lowercase().find("average") {
        let tail = &line[idx..];
        let nums: Vec<f64> = tail
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .take(3)
            .collect();
        if nums.len() == 3 {
            return (Some(nums[0]), Some(nums[1]), Some(nums[2]));
        }
    }
    (None, None, None)
}

/// Uptime in whole seconds from the first field of `/proc/uptime`.
fn parse_uptime(lines: &[String]) -> Option<u64> {
    let first = lines.first()?;
    let secs: f64 = first.split_whitespace().next()?.parse().ok()?;
    Some(secs as u64)
}
