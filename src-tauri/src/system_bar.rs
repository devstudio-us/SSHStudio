//! Android system-bar (status / navigation bar) icon colour.
//!
//! The app draws edge-to-edge, so the system bars sit on top of our own
//! background. Android decides icon colour (light vs dark) from a window
//! appearance flag that does NOT follow the in-app theme toggle, so a dark app
//! theme on a light system theme gives dark icons on a dark bar. The frontend
//! calls this command whenever the resolved theme changes.
//!
//! Desktop (and iOS): a no-op, so the same command name exists everywhere and
//! the frontend never has to branch on the Rust side.

/// `dark = true` → the app is dark → use LIGHT icons. `dark = false` → DARK icons.
#[tauri::command]
pub fn set_status_bar_style(app: tauri::AppHandle, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        window
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _webview| {
                    if apply(env, activity, dark).is_err() {
                        // Never leave a pending Java exception on the UI thread.
                        let _ = env.exception_clear();
                    }
                });
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, dark);
    }
    Ok(())
}

#[cfg(target_os = "android")]
fn apply(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    dark_app: bool,
) -> jni::errors::Result<()> {
    use jni::objects::JValue;

    // View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR / _LIGHT_NAVIGATION_BAR (API < 30).
    const LEGACY_LIGHT_STATUS: i32 = 0x2000;
    const LEGACY_LIGHT_NAV: i32 = 0x10;
    // WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS / _NAVIGATION_BARS.
    const LIGHT_STATUS: i32 = 0x8;
    const LIGHT_NAV: i32 = 0x10;

    let window = env
        .call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?
        .l()?;
    let sdk = env
        .get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?
        .i()?;

    if sdk >= 30 {
        let controller = env
            .call_method(
                &window,
                "getInsetsController",
                "()Landroid/view/WindowInsetsController;",
                &[],
            )?
            .l()?;
        // "light" bars = dark icons. A dark app wants light icons → appearance 0.
        let appearance = if dark_app { 0 } else { LIGHT_STATUS | LIGHT_NAV };
        env.call_method(
            &controller,
            "setSystemBarsAppearance",
            "(II)V",
            &[
                JValue::Int(appearance),
                JValue::Int(LIGHT_STATUS | LIGHT_NAV),
            ],
        )?;
    } else {
        let decor = env
            .call_method(&window, "getDecorView", "()Landroid/view/View;", &[])?
            .l()?;
        let current = env
            .call_method(&decor, "getSystemUiVisibility", "()I", &[])?
            .i()?;
        let flags = LEGACY_LIGHT_STATUS | LEGACY_LIGHT_NAV;
        let next = if dark_app { current & !flags } else { current | flags };
        env.call_method(&decor, "setSystemUiVisibility", "(I)V", &[JValue::Int(next)])?;
    }
    Ok(())
}
