//! Shared layout storage that never conflicts on Google Drive or Dropbox.
//!
//! ```text
//! <root>/.locus/board.json            snapshot everyone reads (rarely rewritten)
//! <root>/.locus/people/<device>.json  one file per computer; only it writes there
//! ```
//!
//! Every record (an image's or a folder box's layout) carries a logical clock
//! `t` and the device `by` that wrote it. Loading merges the snapshot with every
//! person's file and keeps, per key, the record with the highest `(t, by)`.
//! Because each computer writes only its own file, sync services never see two
//! writers on one file, and every computer converges on the same board.
//!
//! The record body is opaque here (the frontend owns its shape); this module
//! only reads `t`, `by` and the identity fields used to follow moved files.

use crate::scan::{ImageEntry, BOARD_DIR};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rec {
    pub t: u64,
    pub by: String,
    #[serde(flatten)]
    pub data: Map<String, Value>,
}

impl Rec {
    fn newer_than(&self, other: &Rec) -> bool {
        (self.t, &self.by) > (other.t, &other.by)
    }
    fn str_field(&self, k: &str) -> Option<&str> {
        self.data.get(k).and_then(|v| v.as_str())
    }
    fn u64_field(&self, k: &str) -> Option<u64> {
        self.data.get(k).and_then(|v| v.as_u64())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDoc {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub clock: u64,
    #[serde(default)]
    pub items: BTreeMap<String, Rec>,
    #[serde(default)]
    pub groups: BTreeMap<String, Rec>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedLayout {
    pub clock: u64,
    /// Item records keyed by the image's current path.
    pub items: BTreeMap<String, Rec>,
    pub groups: BTreeMap<String, Rec>,
    /// Records whose image is not on disk (kept so a returning drive restores them).
    pub missing: BTreeMap<String, Rec>,
    /// Images recognized at a new path since the layout was written.
    pub moved: Vec<Moved>,
    /// Number of people whose edits were merged (including this computer).
    pub people: usize,
}

pub fn board_dir(root: &Path) -> PathBuf {
    root.join(BOARD_DIR)
}

fn people_dir(root: &Path) -> PathBuf {
    board_dir(root).join("people")
}

pub fn own_file(root: &Path, device: &str) -> PathBuf {
    people_dir(root).join(format!("{device}.json"))
}

fn read_doc(path: &Path) -> Option<LayoutDoc> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

fn merge_into(target: &mut BTreeMap<String, Rec>, source: BTreeMap<String, Rec>) {
    for (k, rec) in source {
        match target.get(&k) {
            Some(cur) if !rec.newer_than(cur) => {}
            _ => {
                target.insert(k, rec);
            }
        }
    }
}

/// Every layout document under the board folder: the snapshot, each person's
/// file, and any "conflicted copy" a sync service left behind.
pub fn read_all(root: &Path) -> Vec<LayoutDoc> {
    let mut docs = Vec::new();
    if let Some(doc) = read_doc(&board_dir(root).join("board.json")) {
        docs.push(doc);
    }
    if let Ok(entries) = fs::read_dir(people_dir(root)) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map(|e| e == "json").unwrap_or(false) {
                if let Some(doc) = read_doc(&p) {
                    docs.push(doc);
                }
            }
        }
    }
    docs
}

pub fn merge(docs: Vec<LayoutDoc>) -> (u64, BTreeMap<String, Rec>, BTreeMap<String, Rec>, usize) {
    let mut items = BTreeMap::new();
    let mut groups = BTreeMap::new();
    let mut clock = 0;
    let mut devices = HashSet::new();
    for doc in docs {
        clock = clock.max(doc.clock);
        if !doc.device.is_empty() {
            devices.insert(doc.device.clone());
        }
        for r in doc.items.values().chain(doc.groups.values()) {
            clock = clock.max(r.t);
        }
        merge_into(&mut items, doc.items);
        merge_into(&mut groups, doc.groups);
    }
    (clock, items, groups, devices.len())
}

fn folder_of(path: &str) -> &str {
    path.rfind('/').map(|i| &path[..i]).unwrap_or("")
}

/// Follow images that moved on disk. A record whose path is gone is matched to
/// an unclaimed image by platform file id, then by file name + size (which also
/// works for online-only files that can't be read). A match in another folder
/// is flagged `moved` so the canvas places it in its new box; its size,
/// rotation and flip carry over.
pub fn reconcile(
    items: BTreeMap<String, Rec>,
    images: &[ImageEntry],
) -> (BTreeMap<String, Rec>, BTreeMap<String, Rec>, Vec<Moved>) {
    let on_disk: HashSet<&str> = images.iter().map(|i| i.path.as_str()).collect();
    let mut kept = BTreeMap::new();
    let mut orphans = Vec::new();
    for (path, rec) in items {
        if rec.data.get("gone").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        if on_disk.contains(path.as_str()) {
            kept.insert(path, rec);
        } else {
            orphans.push((path, rec));
        }
    }

    let unclaimed: Vec<&ImageEntry> = images.iter().filter(|i| !kept.contains_key(&i.path)).collect();
    let mut by_id: HashMap<&str, &ImageEntry> = HashMap::new();
    let mut by_name_size: HashMap<(&str, u64), Vec<&ImageEntry>> = HashMap::new();
    for img in &unclaimed {
        if let Some(id) = img.file_id.as_deref() {
            by_id.insert(id, img);
        }
        by_name_size.entry((img.name.as_str(), img.size)).or_default().push(img);
    }

    let mut claimed: HashSet<String> = HashSet::new();
    let mut missing = BTreeMap::new();
    let mut moved = Vec::new();
    for (old, mut rec) in orphans {
        let by_file_id = rec
            .str_field("fileId")
            .and_then(|id| by_id.get(id).copied())
            .filter(|img| !claimed.contains(&img.path));
        let found = by_file_id.or_else(|| {
            let name = rec.str_field("name")?;
            let size = rec.u64_field("size")?;
            by_name_size
                .get(&(name, size))?
                .iter()
                .copied()
                .find(|img| !claimed.contains(&img.path))
        });
        match found {
            Some(img) => {
                if folder_of(&old) != img.folder {
                    rec.data.insert("moved".into(), Value::Bool(true));
                }
                rec.data.insert("fileId".into(), img.file_id.clone().map(Value::String).unwrap_or(Value::Null));
                claimed.insert(img.path.clone());
                moved.push(Moved { from: old, to: img.path.clone() });
                kept.insert(img.path.clone(), rec);
            }
            None => {
                missing.insert(old, rec);
            }
        }
    }
    (kept, missing, moved)
}

pub fn load(root: &Path, images: &[ImageEntry]) -> MergedLayout {
    let (clock, items, groups, people) = merge(read_all(root));
    let (items, missing, moved) = reconcile(items, images);
    MergedLayout { clock, items, groups, missing, moved, people }
}

/// Write this computer's own edits. `doc` holds every record this device has
/// written since its last compaction.
pub fn save_own(root: &Path, doc: &LayoutDoc) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(doc).map_err(std::io::Error::other)?;
    write_atomic(&own_file(root, &doc.device), &bytes)
}

/// Fold everyone's edits into the snapshot. Own files are not emptied here:
/// another computer may still be syncing an older snapshot. Instead,
/// [`trim_own`] later drops only records the snapshot on disk already holds.
pub fn compact(root: &Path) -> std::io::Result<()> {
    let (clock, items, groups, _) = merge(read_all(root));
    let snapshot = LayoutDoc { version: 1, device: String::new(), clock, items, groups };
    let bytes = serde_json::to_vec(&snapshot).map_err(std::io::Error::other)?;
    write_atomic(&board_dir(root).join("board.json"), &bytes)
}

/// Remove from this device's own document every record the snapshot already
/// contains unchanged. Returns the trimmed document.
pub fn trim_own(root: &Path, mut own: LayoutDoc) -> LayoutDoc {
    let Some(snap) = read_doc(&board_dir(root).join("board.json")) else {
        return own;
    };
    own.items.retain(|k, r| snap.items.get(k) != Some(r));
    own.groups.retain(|k, r| snap.groups.get(k) != Some(r));
    own
}

/// This device's own document as last written (empty if none yet).
pub fn read_own(root: &Path, device: &str) -> LayoutDoc {
    read_doc(&own_file(root, device)).unwrap_or(LayoutDoc {
        version: 1,
        device: device.into(),
        ..Default::default()
    })
}
