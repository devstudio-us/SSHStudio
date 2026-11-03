# Contributing to SSHStudio

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Found a bug or have an idea?

Open an [issue](https://github.com/devstudio-us/ssh-studio/issues). For bugs, please include your OS, what you did, what you expected, and what happened (a screenshot helps).

## Setting up

You'll need **Node.js ≥ 22.22.3** (or 24.x), the latest stable **Rust**, and your platform's native build dependencies (see [Build from source](README.md#build-from-source) in the README).

```bash
git clone https://github.com/devstudio-us/ssh-studio.git
cd ssh-studio
npm install
npm run tauri dev
```

## Project layout

```
src/            Angular frontend (standalone components, signals)
src-tauri/      Rust backend (Tauri commands: SSH, SFTP, metrics, hosts, secrets)
  src/lib.rs    App entry point + the Tauri command registry
```

The Rust layer stays thin — networking, filesystem, PTY and keychain only — with product logic in Angular. A backend command is a Rust function annotated `#[tauri::command]`, registered in `src-tauri/src/lib.rs`, and called from the frontend with `invoke("name", { args })`.

## Before you open a PR

Please run these and make sure they pass:

- **Frontend:** `ng build`
- **Backend** (from `src-tauri/`): `cargo build` and `cargo clippy`

A few conventions:

- Branch off `main`.
- Keep commits focused, with a clear message describing the change.
- Match the style of the surrounding code (naming, comments, idioms).
- Favour small, reviewable PRs; if it's a big change, open an issue first so we can agree on the approach.

## Security

Never write passwords, passphrases or key contents to the config files or logs — secrets belong in the OS keychain. Private keys are referenced by path, never copied into app data. If you find a security issue, please report it privately via an issue marked as such rather than a public PR.
