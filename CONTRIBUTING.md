# Contributing to SSHStudio

Thanks for your interest! Bug reports, ideas and pull requests are all welcome. This guide covers how the project is put together and how to get a change in.

## Ways to help

- **Found a bug or have an idea?** Open an [issue](https://github.com/devstudio-us/SSHStudio/issues). For bugs, include your **OS**, what you did, what you expected, and what actually happened (a screenshot helps a lot).
- **Want to fix or build something?** Small, focused PRs are easiest to review. For anything large, please open an issue first so we can agree on the approach before you write code.

## Get it running

You'll need **Node.js ≥ 22.22.3** (or 24.x), the latest stable **Rust**, and your OS's native build tools. The full per-OS setup is in the README's [Build from source](README.md#build-from-source) section.

```bash
git clone https://github.com/devstudio-us/SSHStudio.git
cd SSHStudio
npm install
npm run tauri dev
```

> `npm start` / `ng serve` runs **only the Angular UI** in a browser — it has no Rust backend, so anything that connects (SSH, SFTP, metrics) will fail. Use `npm run tauri dev` for the real app.

## How the project fits together

SSHStudio is one **Angular** app (the UI) talking to a thin **Rust** backend over **Tauri 2**'s IPC. The rule of thumb: the Rust side only does the things a browser can't — networking, filesystem, PTY, keychain — and **all product logic lives in Angular**.

```
src/app/                 Angular UI (standalone components + signals)
  services/              Thin wrappers that call the backend (one per area)
src-tauri/src/           Rust backend
  lib.rs                 App entry point + the list of exposed commands
  ssh.rs                 SSH sessions, terminals, host-key verification
  sftp.rs                SFTP browsing and transfers
  metrics.rs             Dashboard metrics polling
  hosts.rs / notes.rs    TOML stores for hosts and commands
  secrets.rs             Saved passwords via the OS keychain (keyring)
```

Each backend area has a matching Angular service in `src/app/services/` (`ssh.service.ts`, `sftp.service.ts`, …) so components never call the backend directly.

### Adding a backend command

A function the frontend can call needs **two changes in lockstep**:

1. In the relevant Rust file, annotate it `#[tauri::command]`.
2. Add it to the `tauri::generate_handler![ … ]` list in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).

Then call it from the frontend with `invoke("your_command", { someArg })` from `@tauri-apps/api/core` (camelCase args map to the Rust snake_case parameters). Your own commands do **not** need a capability grant — `src-tauri/capabilities/` is only for Tauri's built-in plugin/core APIs.

## Before you open a PR

There's no automated test suite yet, so please:

1. **Build the frontend:** `ng build`
2. **Build & lint the backend** (from `src-tauri/`): `cargo build` **and** `cargo clippy`
3. **Try it in the running app** (`npm run tauri dev`) and confirm your change actually works.

A few conventions:

- Branch off `main`; keep commits focused with a clear message.
- Match the style of the surrounding code — naming, comment density, and idioms.
- If you add or change a Rust dependency, run `cargo build` so `Cargo.lock` updates, and commit it.

## Security

Secrets are handled carefully, and contributions must keep it that way:

- **Never** write passwords, passphrases or key contents to the TOML config files or to logs — saved passwords belong in the OS keychain (`secrets.rs`).
- Private keys are referenced **by path**, never copied into app data.
- Host keys use trust-on-first-use and are refused on a mismatch — don't weaken that.

If you find a security problem, please open an issue and mark it clearly rather than sending a public PR with the details.
