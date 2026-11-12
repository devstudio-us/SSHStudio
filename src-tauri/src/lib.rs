mod backup;
mod hosts;
mod metrics;
mod notes;
mod secrets;
mod settings;
mod sftp;
mod ssh;

use tauri::{Emitter, Manager};

/// macOS Gatekeeper "App Translocation" workaround.
///
/// Because our macOS build is signed ad-hoc (not notarized), a downloaded copy
/// keeps the `com.apple.quarantine` attribute, and macOS then runs it from a
/// random, **read-only** location (`/private/.../AppTranslocation/...`). That
/// read-only path is why the in-app updater fails on macOS with
/// "Read-only file system (os error 30)".
///
/// On launch we fix this ourselves:
/// - If we're running translocated, find the REAL installed copy (in
///   /Applications or ~/Applications), strip its quarantine attribute, and
///   relaunch from that writable path — then the updater works normally.
/// - If we're already running from the real path but it's still quarantined,
///   strip the attribute so a later launch never translocates.
///
/// The very first launch still shows the one-time Gatekeeper "unidentified
/// developer" prompt (only Apple notarization removes that); everything after
/// is clean, including silent in-place updates. No Terminal command needed.
///
/// `std::process::exit(0)` ends this (translocated) process after the real copy
/// has been relaunched; we call this before Tauri starts, so there's no window
/// or state to tear down. (Rust note: functions marked `#[cfg(target_os = ...)]`
/// are compiled only for that OS, so this whole function is absent on Windows
/// and Linux.)
#[cfg(target_os = "macos")]
fn fix_macos_quarantine() {
    use std::path::Path;
    use std::process::Command;

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let translocated = exe.to_string_lossy().contains("/AppTranslocation/");

    // The ".app" bundle directory we live inside (…/SSHStudio.app).
    let bundle_dir = exe
        .ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"));
    let Some(bundle_dir) = bundle_dir else {
        return;
    };
    let Some(bundle_name) = bundle_dir.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return;
    };

    // Helper: does this path still carry the quarantine attribute?
    let has_quarantine = |path: &str| -> bool {
        Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.quarantine", path])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    // Helper: recursively strip quarantine (best effort).
    let strip = |path: &str| {
        let _ = Command::new("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine", path])
            .status();
    };

    if translocated {
        // Running from the read-only translocated copy: locate the real install.
        let mut candidates = vec![format!("/Applications/{bundle_name}")];
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(format!("{home}/Applications/{bundle_name}"));
        }
        let Some(real) = candidates.into_iter().find(|p| Path::new(p).exists()) else {
            return; // installed somewhere unusual; leave it running as-is
        };
        strip(&real);
        // Only relaunch if quarantine is actually gone, otherwise the relaunched
        // copy would translocate again and we'd loop.
        if has_quarantine(&real) {
            return;
        }
        let _ = Command::new("/usr/bin/open")
            .args(["-n", real.as_str()])
            .spawn();
        std::process::exit(0);
    } else {
        // Already running from the real path: if it's still quarantined, clear it
        // so a future launch never translocates and the updater keeps working.
        let real = bundle_dir.to_string_lossy();
        if has_quarantine(&real) {
            strip(&real);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS only: undo Gatekeeper App Translocation so the updater can write.
    #[cfg(target_os = "macos")]
    fix_macos_quarantine();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    // The updater plugin exists on desktop only. Its config (endpoint + public
    // key) lives in tauri.conf.json under `plugins.updater`.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        // macOS always shows a native menu bar; by default its first menu has
        // an "About" item that opens the OS About panel. Replace it with a
        // custom item so it opens OUR About modal instead — keeping About
        // identical across macOS, Windows and Linux. (Windows/Linux have no
        // menu bar; they open the same modal from the topbar logo / Settings.)
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
                let handle = _app.handle().clone();
                let about = MenuItemBuilder::with_id("about", "About SSHStudio").build(&handle)?;
                let app_menu = SubmenuBuilder::new(&handle, "SSHStudio")
                    .item(&about)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                // Keep the standard Edit menu so Cmd+C/V/Z etc. still work.
                let edit_menu = SubmenuBuilder::new(&handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let menu = MenuBuilder::new(&handle)
                    .items(&[&app_menu, &edit_menu])
                    .build()?;
                handle.set_menu(menu)?;
            }
            Ok(())
        })
        // The macOS "About" menu item asks the frontend to open the modal.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "about" {
                // Our About is an in-app modal rendered inside the single
                // webview window. On macOS the menu bar stays active while the
                // window is minimized (or hidden via Cmd+H), so without this
                // the modal would open inside a window the user can't see.
                // Bring the window back to the front first.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("open-about", ());
            }
        })
        .manage(ssh::SessionManager::new())
        .manage(metrics::MetricsManager::new())
        .manage(sftp::SftpManager::new())
        .invoke_handler(tauri::generate_handler![
            hosts::list_hosts,
            hosts::add_host,
            hosts::update_host,
            hosts::delete_host,
            secrets::save_host_password,
            secrets::delete_host_password,
            secrets::has_host_password,
            ssh::connect,
            ssh::attach,
            ssh::disconnect,
            ssh::write_pty,
            ssh::resize_pty,
            metrics::start_metrics,
            metrics::stop_metrics,
            notes::list_notes,
            notes::add_note,
            notes::update_note,
            notes::reorder_notes,
            notes::delete_note,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_download_dir,
            sftp::sftp_upload_dir,
            sftp::sftp_disconnect,
            sftp::local_home,
            sftp::local_list,
            settings::get_settings,
            settings::set_download_dir,
            backup::export_data,
            backup::read_backup,
            backup::import_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
