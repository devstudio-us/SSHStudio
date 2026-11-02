# SSHStudio

A lightweight, cross-platform SSH server manager for **Windows, macOS, and Linux**.
No accounts, no telemetry. Inspired by OmnySSH.

Built with **Tauri 2** (Rust backend) + **Angular** (TypeScript frontend), with
[xterm.js](https://xtermjs.org/) for the terminal.

## Features

- **Hosts** — manage SSH servers in a simple list (stored as TOML on disk).
- **Terminal** — connect with a private key or password; full interactive shell
  via xterm.js. Multiple tabs per host share one authenticated connection, each
  its own independent shell.
- **Dashboard** — live CPU / memory / disk / load / uptime for connected hosts.
- **SFTP** — two-pane file browser (local ↔ remote): navigate, drag-and-drop,
  upload/download files *and* whole folders, with overwrite protection and
  progress bars. Create / rename / delete on the remote side.
- **Commands** — save reusable commands and notes, global or per-host, and run
  them straight into a terminal.
- **Security** — strict host-key verification (trust-on-first-use, refuse on
  mismatch). Passwords and key passphrases are held in memory only, never
  written to disk or logged. Private keys are referenced by path, never copied.

## Prerequisites

Install these once per machine:

| Tool | Version | Notes |
|------|---------|-------|
| [Node.js](https://nodejs.org) | **≥ 22.22.3** (or 24.x) | Angular 22 requires it; older Node fails the build. |
| [Rust](https://rustup.rs) | latest stable | The backend uses Rust edition 2024, so keep the toolchain current (`rustup update`). |

Plus the platform's native build dependencies:

**Windows**
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  (or Visual Studio with "Desktop development with C++"). WebView2 ships with
  Windows 10/11.

**macOS**
```bash
xcode-select --install
```
(The WebKit webview Tauri uses is already part of macOS — no extra libraries.)

**Linux (Debian / Ubuntu)**
```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

See the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) for
other distributions.

## Getting started

```bash
git clone https://github.com/devstudio-us/ssh-studio.git
cd ssh-studio
npm install
npm run tauri dev
```

`npm run tauri dev` launches the Angular dev server (port 1420) and opens the
desktop app window.

> **First run is slow** — Cargo compiles all the Rust crates from scratch, which
> can take several minutes. Subsequent runs are fast.

## Commands

Run from the repo root unless noted. Cargo commands run from `src-tauri/`.

| Command | What it does |
|---------|--------------|
| `npm run tauri dev` | Run the full app in development (the usual command). |
| `npm run tauri build` | Build a production desktop installer for the current OS. |
| `npm start` / `ng serve` | Angular frontend only, in a browser. **`invoke` calls fail here** — no Rust backend, so SSH/SFTP won't work. UI-only work. |
| `ng build` | Build the Angular frontend (output: `dist/sshmanger/browser`). |
| `cargo build` / `cargo clippy` | From `src-tauri/`; run after any Rust change. |

## Project layout

```
src/            Angular frontend (standalone components, signals)
src-tauri/      Rust backend (Tauri commands: SSH, SFTP, metrics, hosts store)
  src/lib.rs    App entry point + the Tauri command registry
```

The frontend is one Angular SPA talking to the Rust backend over Tauri's IPC.
The Rust layer stays thin — only networking, filesystem, PTY, and keychain —
with product logic in Angular. A Tauri command is a Rust function annotated
`#[tauri::command]` and registered in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs);
the frontend calls it with `invoke("name", { args })`.

## Where your data lives

Config is stored as TOML in your OS config directory (e.g. `hosts.toml`,
`notes.toml`, `known_hosts.toml`). Secrets are never stored there — they live in
memory only for the duration of a session.

## Releases

Tagging a commit `vX.Y.Z` and pushing the tag triggers a GitHub Actions workflow
that builds installers for Windows, macOS, and Linux and attaches them to a draft
GitHub release. Downloads are on the
[Releases page](https://github.com/devstudio-us/ssh-studio/releases).

> macOS builds are currently unsigned/un-notarized, so macOS will show a
> Gatekeeper warning on first launch until an Apple Developer ID is configured.
