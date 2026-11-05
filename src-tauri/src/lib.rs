mod backup;
mod hosts;
mod metrics;
mod notes;
mod secrets;
mod settings;
mod sftp;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    // The updater plugin exists on desktop only. Its config (endpoint + public
    // key) lives in tauri.conf.json under `plugins.updater`.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
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
