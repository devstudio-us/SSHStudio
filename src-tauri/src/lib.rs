mod hosts;
mod metrics;
mod notes;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::SessionManager::new())
        .manage(metrics::MetricsManager::new())
        .invoke_handler(tauri::generate_handler![
            hosts::list_hosts,
            hosts::add_host,
            hosts::update_host,
            hosts::delete_host,
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
            notes::delete_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
