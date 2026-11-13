//! File operations the board performs on disk: moving an image into another
//! folder box, copying it, and adding dropped files. Every operation returns
//! the new relative path so the canvas (and its undo stack) can follow it.

use std::fs;
use std::path::{Path, PathBuf};

/// "name.jpg" -> "name 2.jpg", "name 3.jpg", ... until the name is free.
pub fn free_name(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(file_name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} {n}{ext}")))
        .find(|c| !c.exists())
        .expect("an unused name")
}

fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.split('/').any(|seg| seg == ".." ) {
        return Err("Path leaves the board folder".into());
    }
    let p = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    Ok(p)
}

/// Move (or copy) `from` (relative) into the folder `to_folder` (relative).
/// Moves across volumes fall back to copy + delete.
pub fn transfer(root: &Path, from: &str, to_folder: &str, copy: bool) -> Result<String, String> {
    let src = inside(root, from)?;
    let dir = inside(root, to_folder)?;
    if !src.is_file() {
        return Err(format!("{from} is no longer on disk"));
    }
    if !dir.is_dir() {
        return Err(format!("The folder {to_folder} is no longer on disk"));
    }
    let name = src.file_name().ok_or("No file name")?.to_string_lossy().into_owned();
    if !copy && src.parent() == Some(dir.as_path()) {
        return Ok(from.to_string());
    }
    let dest = free_name(&dir, &name);
    if copy {
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    } else if fs::rename(&src, &dest).is_err() {
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        fs::remove_file(&src).map_err(|e| e.to_string())?;
    }
    Ok(crate::scan::rel_path(root, &dest))
}

/// Copy files dropped from outside the board into a folder box.
pub fn import(root: &Path, sources: &[String], to_folder: &str) -> Result<Vec<String>, String> {
    let dir = inside(root, to_folder)?;
    let mut out = Vec::new();
    for s in sources {
        let src = Path::new(s);
        if crate::scan::is_image(src).is_none() || !src.is_file() {
            continue;
        }
        let name = src.file_name().ok_or("No file name")?.to_string_lossy().into_owned();
        let dest = free_name(&dir, &name);
        fs::copy(src, &dest).map_err(|e| e.to_string())?;
        out.push(crate::scan::rel_path(root, &dest));
    }
    Ok(out)
}

pub fn create_folder(root: &Path, parent: &str, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("That folder name can't be used".into());
    }
    let dir = inside(root, parent)?.join(name);
    if dir.exists() {
        return Err(format!("{name} already exists"));
    }
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    Ok(crate::scan::rel_path(root, &dir))
}
