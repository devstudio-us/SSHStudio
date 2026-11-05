# Mobile (Android / iOS) — work in progress

Tracked on the **`mobile-spike`** branch. The goal is one codebase that also
builds for Android/iOS, **without changing desktop behavior** — mobile code is
added behind `#[cfg]` / platform checks only.

## What's been made mobile-safe (code only)

- **Saved passwords (`secrets.rs`).** The `keyring` crate has no Android/iOS
  backend, so it's now desktop-only (`Cargo.toml` target dependency). On mobile,
  `save/has/delete/load_host_password` are no-ops — the add/edit flow still
  completes and connecting just prompts for the password each time. The Tauri
  command names are unchanged, so the frontend is identical. A real mobile store
  (Android Keystore / iOS Keychain) can replace the mobile branch later.
- **Desktop-only plugins.** `tauri-plugin-updater` and `tauri-plugin-process`
  (relaunch) are desktop-only in `Cargo.toml` and registered under
  `#[cfg(desktop)]` in `lib.rs`. Mobile apps update via the app stores.
- **Capabilities.** `updater:default`, `process:allow-restart` and
  `dialog:allow-save` moved to `capabilities/desktop.json`
  (`"platforms": ["linux","macOS","windows"]`) so the mobile ACL doesn't require
  plugins that aren't built there. `capabilities/default.json` keeps only
  mobile-safe permissions (`core`, `opener`, `dialog:allow-open`).

## Build it on a machine with the Android toolchain

Prerequisites (on the build machine, not done in this repo):
- Android Studio with **SDK**, **Platform-Tools**, a **Platform** (e.g. 34),
  **command-line tools**, and the **NDK**.
- **JDK 17+** (Android Studio bundles one under `.../Android Studio/jbr`).
- Env vars: `ANDROID_HOME` → the SDK dir, `NDK_HOME` → `.../ndk/<version>`,
  and `JAVA_HOME` → the JDK.
- Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

Then:
```bash
npm install
npm run tauri android init      # generates src-tauri/gen/android (not committed yet)
npm run tauri android dev       # run on an emulator / device
npm run tauri android build     # produce apk/aab
```
iOS is the same shape (`tauri ios init/dev/build`) but **requires macOS + Xcode
+ an Apple Developer account**.

## Known runtime gaps to expect on mobile (not yet addressed)

These compile but won't work as-is on a phone; they need mobile-specific UI:
- **SFTP "This computer" pane & drag-drop** — mobile apps are sandboxed; use the
  system file picker instead of browsing the local filesystem.
- **Saved passwords** — not persisted on mobile yet (prompted each connect).
- **Terminal + two-pane SFTP layout** — usable but cramped; needs touch-tuned
  layouts beyond the current responsive CSS.

## Rollback

The last desktop-only, known-good commit before mobile work is on `main` /
`staging` (pre-`mobile-spike`). Nothing on `mobile-spike` changes desktop
behavior; it only adds `#[cfg]`-gated mobile branches.
