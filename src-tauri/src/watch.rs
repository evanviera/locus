//! File watching. Image and folder changes trigger a rescan; changes to other
//! people's layout files trigger a layout reload. Events are debounced so a
//! sync service dropping 500 files at once causes one rescan, not 500.

use notify::{event::ModifyKind, recommended_watcher, Event, EventKind, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct BoardWatcher {
    _inner: notify::RecommendedWatcher,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Files,
    Layout,
}

fn classify(root: &Path, path: &Path, own_layout: &Path) -> Option<Kind> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned());
    let first = parts.next()?;
    if first == crate::scan::BOARD_DIR {
        let second = parts.next();
        if second.as_deref() == Some("thumbs") || path == own_layout {
            return None;
        }
        if path.extension().map(|e| e == "tmp").unwrap_or(false) {
            return None;
        }
        return Some(Kind::Layout);
    }
    if first.starts_with('.') {
        return None;
    }
    Some(Kind::Files)
}

pub fn start(app: AppHandle, root: PathBuf, own_layout: PathBuf) -> notify::Result<BoardWatcher> {
    let (tx, rx) = mpsc::channel::<Kind>();
    let r = root.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            // Reads, and a sync app downloading a file (flags and attributes
            // change, the content doesn't), are not changes to the board.
            if matches!(event.kind, EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))) {
                return;
            }
            for p in &event.paths {
                if let Some(kind) = classify(&r, p, &own_layout) {
                    let _ = tx.send(kind);
                }
            }
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let (mut files, mut layout) = (first == Kind::Files, first == Kind::Layout);
            // Quiet period: keep absorbing events until 400 ms pass without one.
            loop {
                match rx.recv_timeout(Duration::from_millis(400)) {
                    Ok(Kind::Files) => files = true,
                    Ok(Kind::Layout) => layout = true,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if files {
                let _ = app.emit("board:files-changed", ());
            } else if layout {
                let _ = app.emit("board:layout-changed", ());
            }
        }
    });
    Ok(BoardWatcher { _inner: watcher })
}
