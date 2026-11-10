mod backup;
mod hosts;
mod metrics;
mod notes;
mod secrets;
mod settings;
mod sftp;
mod ssh;

use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // The process (relaunch) and updater plugins are desktop-only. The updater's
    // config (endpoint + public key) lives in tauri.conf.json under
    // `plugins.updater`.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

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
