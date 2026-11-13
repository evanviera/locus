//! Thumbnails: decode once, keep two sizes on disk, serve them to the canvas.
//!
//! Tiers are 256 px and 1024 px on the longest edge (the canvas derives its
//! 64 px atlas tiles from the 256 tier). One decode produces both. Cached files
//! live in the app's cache folder, keyed by path + size + modified time, so an
//! edited image gets fresh thumbnails and an untouched one never decodes again.

use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageEncoder};
use std::fs;
use std::path::{Path, PathBuf};
use xxhash_rust::xxh3::xxh3_64;

pub const TIERS: [u32; 2] = [256, 1024];
pub const VIEWER_EDGE: u32 = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Small,
    Large,
    /// The original when the webview can show it, else a 2048 px render.
    Full,
}

impl Tier {
    pub fn parse(s: &str) -> Option<Tier> {
        match s {
            "256" => Some(Tier::Small),
            "1024" => Some(Tier::Large),
            "full" => Some(Tier::Full),
            _ => None,
        }
    }
}

pub struct Thumb {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

fn cache_key(path: &Path) -> std::io::Result<String> {
    let meta = fs::metadata(path)?;
    let mtime = crate::scan::mtime_ms(&meta);
    let raw = format!("{}\u{0}{}\u{0}{}", path.to_string_lossy(), meta.len(), mtime);
    Ok(format!("{:016x}", xxh3_64(raw.as_bytes())))
}

fn cache_file(cache_dir: &Path, key: &str, edge: u32, alpha: bool) -> PathBuf {
    let ext = if alpha { "png" } else { "jpg" };
    cache_dir.join(&key[..2]).join(format!("{key}-{edge}.{ext}"))
}

fn find_cached(cache_dir: &Path, key: &str, edge: u32) -> Option<Thumb> {
    for (alpha, mime) in [(false, "image/jpeg"), (true, "image/png")] {
        let file = cache_file(cache_dir, key, edge, alpha);
        if let Ok(bytes) = fs::read(&file) {
            return Some(Thumb { bytes, mime });
        }
    }
    None
}

pub fn decode(path: &Path) -> Result<DynamicImage, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "psd" {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let psd = psd::Psd::from_bytes(&bytes).map_err(|e| e.to_string())?;
        let rgba = image::RgbaImage::from_raw(psd.width(), psd.height(), psd.rgba())
            .ok_or("PSD composite has an unexpected size")?;
        return Ok(DynamicImage::ImageRgba8(rgba));
    }
    image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())
}

fn has_alpha(img: &DynamicImage) -> bool {
    if !img.color().has_alpha() {
        return false;
    }
    // Many PNGs carry an alpha channel that is fully opaque; store those as JPEG.
    let rgba = img.to_rgba8();
    rgba.pixels().step_by(7).any(|p| p.0[3] < 250)
}

fn encode(img: &DynamicImage, alpha: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    if alpha {
        let rgba = img.to_rgba8();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?;
    } else {
        let rgb = img.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 84)
            .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn shrink(img: &DynamicImage, edge: u32) -> DynamicImage {
    if img.width().max(img.height()) <= edge {
        img.clone()
    } else {
        img.thumbnail(edge, edge)
    }
}

/// Decode the original once and write every tier. Returns the requested one.
fn build(path: &Path, cache_dir: &Path, key: &str, want: u32) -> Result<Thumb, String> {
    let original = decode(path)?;
    let alpha = has_alpha(&original);
    let mut wanted = None;
    let large = shrink(&original, TIERS[1]);
    for edge in TIERS.iter().rev() {
        let img = if *edge == TIERS[1] { large.clone() } else { shrink(&large, *edge) };
        let bytes = encode(&img, alpha)?;
        let file = cache_file(cache_dir, key, *edge, alpha);
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = file.with_extension("tmp");
        if fs::write(&tmp, &bytes).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
        if *edge == want {
            wanted = Some(Thumb { bytes, mime: if alpha { "image/png" } else { "image/jpeg" } });
        }
    }
    if want == VIEWER_EDGE {
        let img = shrink(&original, VIEWER_EDGE);
        let bytes = encode(&img, alpha)?;
        let file = cache_file(cache_dir, key, VIEWER_EDGE, alpha);
        let _ = fs::write(&file, &bytes);
        wanted = Some(Thumb { bytes, mime: if alpha { "image/png" } else { "image/jpeg" } });
    }
    wanted.ok_or_else(|| "no tier".into())
}

fn browser_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    Some(match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

pub fn get(path: &Path, tier: Tier, cache_dir: &Path) -> Result<Thumb, String> {
    if tier == Tier::Full {
        if let Some(mime) = browser_mime(path) {
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            return Ok(Thumb { bytes, mime });
        }
    }
    let edge = match tier {
        Tier::Small => TIERS[0],
        Tier::Large => TIERS[1],
        Tier::Full => VIEWER_EDGE,
    };
    let key = cache_key(path).map_err(|e| e.to_string())?;
    if let Some(hit) = find_cached(cache_dir, &key, edge) {
        return Ok(hit);
    }
    build(path, cache_dir, &key, edge)
}

/// Shared previews in `<root>/.locus/thumbs/` let teammates see an image
/// without downloading the original from Google Drive or Dropbox. They are
/// keyed by file name + size, so they follow a file when it moves.
fn shared_file(root: &Path, path: &Path) -> Option<PathBuf> {
    let meta = fs::metadata(path).ok()?;
    let name = path.file_name()?.to_string_lossy();
    let key = format!("{:016x}", xxh3_64(format!("{name}\u{0}{}", meta.len()).as_bytes()));
    Some(root.join(crate::scan::BOARD_DIR).join("thumbs").join(&key[..2]).join(format!("{key}.jpg")))
}

fn is_online_only(path: &Path) -> bool {
    fs::metadata(path).map(|m| crate::scan::online_only(&m)).unwrap_or(false)
}

/// Board-aware lookup: never reads an online-only original in the background
/// (only the viewer's Full tier may download it), serves the shared preview
/// when there is one, and publishes a shared preview after building one.
pub fn get_for_board(root: &Path, path: &Path, tier: Tier, cache_dir: &Path) -> Result<Thumb, String> {
    let shared = shared_file(root, path);
    if tier != Tier::Full && is_online_only(path) {
        let file = shared.ok_or("online-only")?;
        let bytes = fs::read(file).map_err(|_| "online-only".to_string())?;
        return Ok(Thumb { bytes, mime: "image/jpeg" });
    }
    let thumb = get(path, tier, cache_dir)?;
    if tier == Tier::Small {
        if let Some(file) = shared {
            if !file.exists() {
                // Shared previews are always JPEG so every computer can read them
                // the same way; transparent images are flattened onto mid grey.
                let bytes = if thumb.mime == "image/jpeg" {
                    Some(thumb.bytes.clone())
                } else {
                    image::load_from_memory(&thumb.bytes).ok().and_then(|img| {
                        let mut bg = image::RgbaImage::from_pixel(img.width(), img.height(), image::Rgba([128, 128, 128, 255]));
                        image::imageops::overlay(&mut bg, &img.to_rgba8(), 0, 0);
                        encode(&DynamicImage::ImageRgba8(bg), false).ok()
                    })
                };
                if let (Some(bytes), Some(dir)) = (bytes, file.parent()) {
                    let _ = fs::create_dir_all(dir);
                    let tmp = file.with_extension("tmp");
                    if fs::write(&tmp, bytes).is_ok() {
                        let _ = fs::rename(&tmp, &file);
                    }
                }
            }
        }
    }
    Ok(thumb)
}
