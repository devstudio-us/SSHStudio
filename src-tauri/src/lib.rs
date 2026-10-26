mod hosts;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ssh::SessionManager::new())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
