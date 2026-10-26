mod hosts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            hosts::list_hosts,
            hosts::add_host,
            hosts::update_host,
            hosts::delete_host,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
