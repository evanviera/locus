use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu},
    AppHandle, Emitter,
};

fn item(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<tauri::Wry>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("Locus"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .comments(Some("Folders as reference boards"))
        .build();
    let app_menu = Submenu::with_items(
        app,
        "Locus",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Locus"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "locus:check-updates", "Check for Updates…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "locus:open", "Open Folder…", Some("CmdOrCtrl+O"))?,
            &item(app, "locus:reload", "Rescan Folder", Some("CmdOrCtrl+R"))?,
            &item(app, "locus:reveal-root", "Show Board Folder", Some("CmdOrCtrl+Shift+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "locus:new-folder", "New Folder", Some("CmdOrCtrl+Shift+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &item(app, "locus:undo", "Undo", Some("CmdOrCtrl+Z"))?,
            &item(app, "locus:redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "locus:find", "Find…", Some("CmdOrCtrl+F"))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(app, "locus:fit", "Fit Board", Some("CmdOrCtrl+0"))?,
            &item(app, "locus:sidebar", "Toggle Folders", Some("CmdOrCtrl+\\"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "locus:theme", "Theme…", None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}

pub fn forward(app: &AppHandle, id: &str) {
    if let Some(cmd) = id.strip_prefix("locus:") {
        let _ = app.emit("menu", cmd.to_string());
    }
}
