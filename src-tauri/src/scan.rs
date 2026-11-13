//! Folder scanning: walk a board's root, list folders and images, and read each
//! image's pixel size from its file header (no decode). This is what lets the
//! canvas lay out thousands of images before a single thumbnail exists.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};
use walkdir::WalkDir;

/// The hidden folder at the board root that holds layout and shared thumbnails.
pub const BOARD_DIR: &str = ".locus";

pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "psd",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    /// Path relative to the root, with `/` separators. The root itself is "".
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
    pub path: String,
    pub folder: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    /// Modified time in milliseconds since the epoch.
    pub mtime: u64,
    pub width: u32,
    pub height: u32,
    /// Platform file id (inode+device, or Windows file index) when available.
    pub file_id: Option<String>,
    /// True when the file is a cloud placeholder (online-only) that must not
    /// be read in the background.
    pub online_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub folders: Vec<Folder>,
    pub images: Vec<ImageEntry>,
    pub elapsed_ms: u64,
}

/// Header sizes are cached by (path, size, mtime) so a rescan after a file
/// event only opens files that changed.
#[derive(Default)]
pub struct DimCache {
    map: Mutex<HashMap<(PathBuf, u64, u64), (u32, u32)>>,
}

impl DimCache {
    /// Pixel size of a local file (from the cache or its header). None for an
    /// online-only file, whose header can't be read without downloading it.
    pub fn size_of(&self, path: &Path) -> Option<(u32, u32)> {
        let meta = std::fs::metadata(path).ok()?;
        if online_only(&meta) {
            return None;
        }
        let key = (path.to_path_buf(), meta.len(), mtime_ms(&meta));
        if let Some(d) = self.map.lock().ok().and_then(|m| m.get(&key).copied()) {
            return Some(d);
        }
        let d = header_size(path)?;
        if let Ok(mut m) = self.map.lock() {
            m.insert(key, d);
        }
        Some(d)
    }
}

pub fn rel_path(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn parent_of(rel: &str) -> String {
    match rel.rfind('/') {
        Some(i) => rel[..i].to_string(),
        None => String::new(),
    }
}

pub fn is_image(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    IMAGE_EXTS.contains(&ext.as_str()).then_some(ext)
}

fn hidden(name: &str) -> bool {
    name.starts_with('.') || name == "$RECYCLE.BIN" || name == "__MACOSX"
}

#[cfg(unix)]
fn file_id(meta: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!("{:x}-{:x}", meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn file_id(_meta: &std::fs::Metadata) -> Option<String> {
    // Windows file index needs an open handle; filled in by a later pass.
    None
}

#[cfg(target_os = "macos")]
pub fn online_only(meta: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(windows)]
pub fn online_only(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    const OFFLINE: u32 = 0x0000_1000;
    meta.file_attributes() & (RECALL_ON_DATA_ACCESS | OFFLINE) != 0
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn online_only(_meta: &std::fs::Metadata) -> bool {
    false
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pixel size from the header. PSD headers are read by hand (width/height at
/// fixed offsets) because imagesize treats them as unknown on some versions.
pub fn header_size(path: &Path) -> Option<(u32, u32)> {
    if let Ok(size) = imagesize::size(path) {
        return Some((size.width as u32, size.height as u32));
    }
    let mut buf = [0u8; 26];
    let mut f = std::fs::File::open(path).ok()?;
    std::io::Read::read_exact(&mut f, &mut buf).ok()?;
    if &buf[0..4] == b"8BPS" {
        let h = u32::from_be_bytes(buf[14..18].try_into().ok()?);
        let w = u32::from_be_bytes(buf[18..22].try_into().ok()?);
        return Some((w, h));
    }
    None
}

pub fn scan(root: &Path, cache: &DimCache) -> ScanResult {
    let started = Instant::now();
    let mut folders = vec![Folder {
        path: String::new(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        parent: None,
    }];
    let mut files: Vec<(PathBuf, String, std::fs::Metadata)> = Vec::new();

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !hidden(&e.file_name().to_string_lossy()));
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        if entry.file_type().is_dir() {
            let rel = rel_path(root, path);
            folders.push(Folder {
                name: entry.file_name().to_string_lossy().into_owned(),
                parent: Some(parent_of(&rel)),
                path: rel,
            });
        } else if let Some(ext) = is_image(path) {
            if let Ok(meta) = entry.metadata() {
                files.push((path.to_path_buf(), ext, meta));
            }
        }
    }

    let mut images: Vec<ImageEntry> = files
        .par_iter()
        .filter_map(|(path, ext, meta)| {
            let size = meta.len();
            let mtime = mtime_ms(meta);
            let cloud = online_only(meta);
            let key = (path.clone(), size, mtime);
            let cached = cache.map.lock().ok().and_then(|m| m.get(&key).copied());
            let dims = match cached {
                Some(d) => Some(d),
                // Reading even a header downloads an online-only file, so its
                // size comes from the shared board data instead (0 = unknown).
                None if cloud => Some((0, 0)),
                None => {
                    let d = header_size(path)?;
                    if let Ok(mut m) = cache.map.lock() {
                        m.insert(key, d);
                    }
                    Some(d)
                }
            }?;
            let rel = rel_path(root, path);
            Some(ImageEntry {
                folder: parent_of(&rel),
                name: path.file_name()?.to_string_lossy().into_owned(),
                ext: ext.clone(),
                size,
                mtime,
                width: dims.0,
                height: dims.1,
                file_id: file_id(meta),
                online_only: cloud,
                path: rel,
            })
        })
        .collect();

    images.sort_by(|a, b| natural_cmp(&a.path, &b.path));
    folders.sort_by(|a, b| natural_cmp(&a.path, &b.path));

    ScanResult {
        root: root.to_string_lossy().into_owned(),
        folders,
        images,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

/// Case-insensitive natural order, so "shot 2" sorts before "shot 10".
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = a.peek().copied().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    a.next();
                }
                let mut nb = String::new();
                while let Some(c) = b.peek().copied().filter(|c| c.is_ascii_digit()) {
                    nb.push(c);
                    b.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then(ta.cmp(tb));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}
