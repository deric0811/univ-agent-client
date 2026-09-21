mod commands;
mod projects;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::AuthState(Default::default()))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::login,
            commands::logout,
            commands::is_authenticated,
            commands::extract_audio_ffmpeg,
            commands::upload_job,
            commands::get_job_status,
            commands::get_job_result,
            commands::save_study_project,
            commands::list_study_projects,
            commands::load_study_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
