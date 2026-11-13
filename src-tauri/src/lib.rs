//! Locus: folders shown as boxes on one canvas, images arranged freely inside.
//! This file holds app setup, the `thumb://` protocol and the IPC commands.
//! Subsystems live in their own modules.

mod fsops;
mod layout_store;
mod menu;
mod scan;
mod thumbs;
mod watch;

#[cfg(test)]
mod tests;

use layout_store::{LayoutDoc, MergedLayout};
use scan::{DimCache, ScanResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{http, AppHandle, Manager, State};

struct AppState {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<watch::BoardWatcher>>,
    dims: DimCache,
    device: String,
    cache_dir: PathBuf,
    /// Reads of online-only files wait on a download, so they get their own
    /// few threads and never hold up local thumbnails.
    cloud: rayon::ThreadPool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardPayload {
    scan: ScanResult,
    layout: MergedLayout,
    own: LayoutDoc,
    device: String,
}

fn current_root(state: &AppState) -> Result<PathBuf, String> {
    state.root.lock().unwrap().clone().ok_or_else(|| "No folder is open".into())
}

fn device_id(config_dir: &Path) -> String {
    let file = config_dir.join("device-id");
    if let Ok(id) = std::fs::read_to_string(&file) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }
    let seed = format!(
        "{:?}{}{:?}",
        std::time::SystemTime::now(),
        std::process::id(),
        std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")).ok()
    );
    let id = format!("{:012x}", xxhash_rust::xxh3::xxh3_64(seed.as_bytes()) & 0xffff_ffff_ffff);
    let _ = std::fs::create_dir_all(config_dir);
    let _ = std::fs::write(&file, &id);
    id
}

fn load_board(state: &AppState, root: &Path) -> BoardPayload {
    let scan = scan::scan(root, &state.dims);
    let layout = layout_store::load(root, &scan.images);
    let own = layout_store::trim_own(root, layout_store::read_own(root, &state.device));
    BoardPayload { scan, layout, own, device: state.device.clone() }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open a folder as a board")
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
async fn open_board(app: AppHandle, root: String) -> Result<BoardPayload, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("That folder is no longer on disk".into());
    }
    let state = app.state::<AppState>();
    *state.root.lock().unwrap() = Some(root.clone());
    let own_file = layout_store::own_file(&root, &state.device);
    let watcher = watch::start(app.clone(), root.clone(), own_file).ok();
    *state.watcher.lock().unwrap() = watcher;
    let a = app.clone();
    blocking(move || load_board(&a.state::<AppState>(), &root)).await
}

#[tauri::command]
async fn rescan(app: AppHandle) -> Result<BoardPayload, String> {
    let root = current_root(&app.state::<AppState>())?;
    let a = app.clone();
    blocking(move || load_board(&a.state::<AppState>(), &root)).await
}

#[tauri::command]
fn save_layout(state: State<AppState>, own: LayoutDoc) -> Result<(), String> {
    let root = current_root(&state)?;
    let mut own = own;
    own.device = state.device.clone();
    own.version = 1;
    layout_store::save_own(&root, &own).map_err(|e| e.to_string())
}

#[tauri::command]
async fn compact_layout(app: AppHandle) -> Result<(), String> {
    let root = current_root(&app.state::<AppState>())?;
    blocking(move || layout_store::compact(&root).map_err(|e| e.to_string())).await?
}

#[tauri::command]
fn move_image(state: State<AppState>, from: String, to_folder: String, copy: bool) -> Result<String, String> {
    fsops::transfer(&current_root(&state)?, &from, &to_folder, copy)
}

#[tauri::command]
fn import_files(state: State<AppState>, sources: Vec<String>, to_folder: String) -> Result<Vec<String>, String> {
    fsops::import(&current_root(&state)?, &sources, &to_folder)
}

#[tauri::command]
fn create_folder(state: State<AppState>, parent: String, name: String) -> Result<String, String> {
    fsops::create_folder(&current_root(&state)?, &parent, &name)
}

#[tauri::command]
fn reveal(state: State<AppState>, path: String) -> Result<(), String> {
    let root = current_root(&state)?;
    let target = if path.is_empty() { root.clone() } else { root.join(&path) };
    let folder = if target.is_dir() { target } else { target.parent().unwrap_or(&root).to_path_buf() };
    open::that_detached(folder).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(state: State<AppState>, path: String) -> Result<(), String> {
    open::that_detached(current_root(&state)?.join(path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 3 <= bytes.len() {
            if let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(status: u16, mime: &str, body: Vec<u8>, size: Option<(u32, u32)>) -> http::Response<Vec<u8>> {
    let mut res = http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "X-Image-Size")
        .header("Cache-Control", "no-store");
    if let Some((w, h)) = size {
        res = res.header("X-Image-Size", format!("{w}x{h}"));
    }
    res.body(body).unwrap()
}

/// `thumb://localhost/<tier>/<url-encoded relative path>` → tier and path.
/// The frontend encodes "<tier>/<path>" as one URI component.
fn parse_thumb(state: &AppState, uri_path: &str) -> Result<(thumbs::Tier, PathBuf, PathBuf), u16> {
    let decoded = percent_decode(uri_path);
    let trimmed = decoded.trim_start_matches('/');
    let (tier, rel) = trimmed.split_once('/').ok_or(400u16)?;
    let tier = thumbs::Tier::parse(tier).ok_or(404u16)?;
    let root = current_root(state).map_err(|_| 404u16)?;
    if rel.split('/').any(|s| s == "..") {
        return Err(403);
    }
    let path = root.join(rel);
    Ok((tier, root, path))
}

/// Serves the image and, for the small tier, its pixel size in `X-Image-Size`
/// so the board learns the shape of files that were online-only at scan time.
fn serve_thumb(state: &AppState, tier: thumbs::Tier, root: &Path, path: &Path) -> http::Response<Vec<u8>> {
    match thumbs::get_for_board(root, path, tier, &state.cache_dir) {
        Ok(t) => {
            let size = if tier == thumbs::Tier::Small { state.dims.size_of(path) } else { None };
            respond(200, t.mime, t.bytes, size)
        }
        Err(e) => respond(404, "text/plain", e.into_bytes(), None),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let cache_dir = app.path().app_cache_dir()?.join("thumbs");
            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState {
                root: Mutex::new(None),
                watcher: Mutex::new(None),
                dims: DimCache::default(),
                device: device_id(&config_dir),
                cache_dir,
                cloud: rayon::ThreadPoolBuilder::new()
                    .num_threads(6)
                    .thread_name(|i| format!("locus-cloud-{i}"))
                    .build()
                    .expect("cloud thread pool"),
            });
            Ok(())
        })
        .menu(menu::build)
        .on_menu_event(|app, event| menu::forward(app, event.id().as_ref()))
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let state = app.state::<AppState>();
            match parse_thumb(&state, &path) {
                Err(status) => responder.respond(respond(status, "text/plain", Vec::new(), None)),
                Ok((tier, root, file)) => {
                    let cloud = thumbs::is_online_only(&file);
                    let job = {
                        let app = app.clone();
                        move || {
                            let state = app.state::<AppState>();
                            responder.respond(serve_thumb(&state, tier, &root, &file));
                        }
                    };
                    if cloud {
                        state.cloud.spawn(job);
                    } else {
                        rayon::spawn(job);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            open_board,
            rescan,
            save_layout,
            compact_layout,
            move_image,
            import_files,
            create_folder,
            reveal,
            open_file,
            restart_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Locus");
}
