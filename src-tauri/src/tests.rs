use crate::layout_store::{self, LayoutDoc, Rec};
use crate::{fsops, scan, thumbs};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

fn write_jpg(path: &Path, w: u32, h: u32) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 255) as u8, (y % 255) as u8, 90]));
    img.save(path).unwrap();
}

fn rec(t: u64, by: &str, extra: Value) -> Rec {
    let data: Map<String, Value> = serde_json::from_value(extra).unwrap();
    Rec { t, by: by.into(), data }
}

fn doc(device: &str, items: Vec<(&str, Rec)>) -> LayoutDoc {
    LayoutDoc {
        version: 1,
        device: device.into(),
        clock: items.iter().map(|(_, r)| r.t).max().unwrap_or(0),
        items: items.into_iter().map(|(k, r)| (k.to_string(), r)).collect(),
        groups: BTreeMap::new(),
    }
}

#[test]
fn scan_lists_folders_and_reads_sizes_from_headers() {
    let dir = tempfile::tempdir().unwrap();
    write_jpg(&dir.path().join("a.jpg"), 40, 20);
    write_jpg(&dir.path().join("chars/hero 10.jpg"), 10, 30);
    write_jpg(&dir.path().join("chars/hero 2.jpg"), 10, 30);
    write_jpg(&dir.path().join(".locus/thumbs/ab/x.jpg"), 4, 4);
    fs::write(dir.path().join("chars/notes.txt"), "hi").unwrap();

    let result = scan::scan(dir.path(), &scan::DimCache::default());
    let paths: Vec<_> = result.images.iter().map(|i| i.path.as_str()).collect();
    assert_eq!(paths, vec!["a.jpg", "chars/hero 2.jpg", "chars/hero 10.jpg"]);
    assert_eq!((result.images[0].width, result.images[0].height), (40, 20));
    assert_eq!(result.images[1].folder, "chars");
    let folders: Vec<_> = result.folders.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(folders, vec!["", "chars"]);
}

#[test]
fn merge_keeps_the_newest_edit_per_image() {
    let a = doc("aaa", vec![("x.jpg", rec(5, "aaa", json!({"x": 1}))), ("y.jpg", rec(2, "aaa", json!({"x": 1})))]);
    let b = doc("bbb", vec![("x.jpg", rec(4, "bbb", json!({"x": 2}))), ("y.jpg", rec(3, "bbb", json!({"x": 2})))]);
    let (clock, items, _, people) = layout_store::merge(vec![a.clone(), b.clone()]);
    assert_eq!(clock, 5);
    assert_eq!(people, 2);
    assert_eq!(items["x.jpg"].data["x"], 1);
    assert_eq!(items["y.jpg"].data["x"], 2);
    // Order of reading never changes the result.
    let (_, again, _, _) = layout_store::merge(vec![b, a]);
    assert_eq!(items, again);
}

#[test]
fn equal_clocks_break_ties_by_device() {
    let a = doc("aaa", vec![("x.jpg", rec(7, "aaa", json!({"x": 1})))]);
    let b = doc("bbb", vec![("x.jpg", rec(7, "bbb", json!({"x": 2})))]);
    let (_, items, _, _) = layout_store::merge(vec![b.clone(), a.clone()]);
    let (_, again, _, _) = layout_store::merge(vec![a, b]);
    assert_eq!(items["x.jpg"].by, "bbb");
    assert_eq!(items, again);
}

#[test]
fn each_device_writes_only_its_own_file_and_both_are_read() {
    let dir = tempfile::tempdir().unwrap();
    write_jpg(&dir.path().join("x.jpg"), 8, 8);
    layout_store::save_own(dir.path(), &doc("aaa", vec![("x.jpg", rec(1, "aaa", json!({"x": 1})))])).unwrap();
    layout_store::save_own(dir.path(), &doc("bbb", vec![("x.jpg", rec(2, "bbb", json!({"x": 9})))])).unwrap();
    // A "conflicted copy" a sync service left behind is read too.
    fs::copy(
        dir.path().join(".locus/people/aaa.json"),
        dir.path().join(".locus/people/aaa (conflicted copy).json"),
    )
    .unwrap();
    let images = scan::scan(dir.path(), &scan::DimCache::default()).images;
    let merged = layout_store::load(dir.path(), &images);
    assert_eq!(merged.items["x.jpg"].data["x"], 9);
    assert!(dir.path().join(".locus/people/aaa.json").exists());
    assert!(dir.path().join(".locus/people/bbb.json").exists());
}

#[test]
fn moved_files_keep_their_layout() {
    let dir = tempfile::tempdir().unwrap();
    write_jpg(&dir.path().join("old/hero.jpg"), 30, 10);
    let before = scan::scan(dir.path(), &scan::DimCache::default()).images;
    let img = &before[0];
    let r = rec(1, "aaa", json!({"w": 300, "rot": 15, "fileId": img.file_id, "name": img.name, "size": img.size}));
    layout_store::save_own(dir.path(), &doc("aaa", vec![("old/hero.jpg", r)])).unwrap();

    fs::create_dir_all(dir.path().join("new")).unwrap();
    fs::rename(dir.path().join("old/hero.jpg"), dir.path().join("new/hero.jpg")).unwrap();
    let after = scan::scan(dir.path(), &scan::DimCache::default()).images;
    let merged = layout_store::load(dir.path(), &after);
    let moved = &merged.items["new/hero.jpg"];
    assert_eq!(moved.data["rot"], 15);
    assert_eq!(moved.data["moved"], true);
    assert!(merged.missing.is_empty());
    assert_eq!(merged.moved[0].from, "old/hero.jpg");
}

#[test]
fn renamed_and_copied_across_volumes_matches_by_name_and_size() {
    let dir = tempfile::tempdir().unwrap();
    write_jpg(&dir.path().join("a/pic.jpg"), 12, 12);
    let img = scan::scan(dir.path(), &scan::DimCache::default()).images[0].clone();
    // A different file id (as after a cross-volume copy or a sync re-download).
    let r = rec(1, "aaa", json!({"w": 1, "fileId": "other", "name": "pic.jpg", "size": img.size}));
    let mut items = BTreeMap::new();
    items.insert("gone/pic.jpg".to_string(), r);
    let (kept, missing, _) = layout_store::reconcile(items, &[img]);
    assert!(kept.contains_key("a/pic.jpg"));
    assert!(missing.is_empty());
}

#[test]
fn files_that_are_gone_are_kept_as_missing() {
    let mut items = BTreeMap::new();
    items.insert("lost.jpg".to_string(), rec(1, "aaa", json!({"name": "lost.jpg", "size": 5})));
    let (kept, missing, _) = layout_store::reconcile(items, &[]);
    assert!(kept.is_empty());
    assert!(missing.contains_key("lost.jpg"));
}

#[test]
fn trim_own_drops_only_records_the_snapshot_holds() {
    let dir = tempfile::tempdir().unwrap();
    let own = doc("aaa", vec![("x.jpg", rec(1, "aaa", json!({"x": 1})))]);
    layout_store::save_own(dir.path(), &own).unwrap();
    layout_store::compact(dir.path()).unwrap();
    let newer = doc("aaa", vec![("x.jpg", rec(1, "aaa", json!({"x": 1}))), ("y.jpg", rec(2, "aaa", json!({"x": 2})))]);
    let trimmed = layout_store::trim_own(dir.path(), newer);
    assert!(!trimmed.items.contains_key("x.jpg"));
    assert!(trimmed.items.contains_key("y.jpg"));
}

#[test]
fn moving_between_folders_avoids_name_clashes() {
    let dir = tempfile::tempdir().unwrap();
    write_jpg(&dir.path().join("a/pic.jpg"), 4, 4);
    write_jpg(&dir.path().join("b/pic.jpg"), 4, 4);
    let moved = fsops::transfer(dir.path(), "a/pic.jpg", "b", false).unwrap();
    assert_eq!(moved, "b/pic 2.jpg");
    assert!(!dir.path().join("a/pic.jpg").exists());
    let copied = fsops::transfer(dir.path(), "b/pic.jpg", "a", true).unwrap();
    assert_eq!(copied, "a/pic.jpg");
    assert!(dir.path().join("b/pic.jpg").exists());
    assert!(fsops::transfer(dir.path(), "../etc/passwd", "a", false).is_err());
}

#[test]
fn thumbnails_are_built_once_then_served_from_cache() {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let src = dir.path().join("big.jpg");
    write_jpg(&src, 3000, 1500);
    let small = thumbs::get_for_board(dir.path(), &src, thumbs::Tier::Small, cache.path()).unwrap();
    let decoded = image::load_from_memory(&small.bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (256, 128));
    let large = thumbs::get(&src, thumbs::Tier::Large, cache.path()).unwrap();
    assert_eq!(image::load_from_memory(&large.bytes).unwrap().width(), 1024);
    // The shared team preview was published next to the board.
    assert!(walk_count(&dir.path().join(".locus/thumbs")) == 1);
    // Delete the original's pixels: a cache hit must not decode again.
    let cached_count = walk_count(cache.path());
    assert_eq!(cached_count, 2);
}

fn walk_count(p: &Path) -> usize {
    walkdir::WalkDir::new(p).into_iter().flatten().filter(|e| e.file_type().is_file()).count()
}

/// Speed check, run with:
/// `cargo test --release -- --ignored speed --nocapture`
#[test]
#[ignore]
fn speed_scan_and_thumbnails() {
    let n: usize = std::env::var("LOCUS_SPEED_N").ok().and_then(|v| v.parse().ok()).unwrap_or(2000);
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let t = std::time::Instant::now();
    use rayon::prelude::*;
    (0..n).into_par_iter().for_each(|i| {
        let folder = format!("set {}/shot {}", i % 12, i % 40);
        let (w, h) = if i % 3 == 0 { (1600, 2200) } else { (2400, 1350) };
        write_jpg(&dir.path().join(folder).join(format!("frame {i}.jpg")), w, h);
    });
    println!("generated {n} images in {:?}", t.elapsed());

    let t = std::time::Instant::now();
    let result = scan::scan(dir.path(), &scan::DimCache::default());
    println!("scan + header sizes: {} images, {} folders in {:?}", result.images.len(), result.folders.len(), t.elapsed());
    assert_eq!(result.images.len(), n);

    let t = std::time::Instant::now();
    result.images.par_iter().for_each(|img| {
        thumbs::get(&dir.path().join(&img.path), thumbs::Tier::Small, cache.path()).unwrap();
    });
    println!("cold thumbnails (both tiers): {:?} ({:.1} ms per image per core)", t.elapsed(),
        t.elapsed().as_secs_f64() * 1000.0 * rayon::current_num_threads() as f64 / n as f64);

    let t = std::time::Instant::now();
    result.images.par_iter().for_each(|img| {
        thumbs::get(&dir.path().join(&img.path), thumbs::Tier::Small, cache.path()).unwrap();
    });
    println!("warm thumbnails: {:?}", t.elapsed());
}
