# Folder reference board: product and build plan

Working name: **Locus** (see Names; not final). Status: plan only, no code yet. Written Nov 13 2026, updated the same day with Evan's decisions: shared layouts, moving files between boxes, and team use on Google Drive and Dropbox.

## 1. The idea in one paragraph

Open any folder and see every image under it on one infinite canvas. Each folder is a box, and its subfolders are boxes inside it, laid out like a disk-space map. Inside a box you arrange freely: move, resize, rotate, flip, stack. Nothing gets packaged. The images stay where they are on disk, and the arrangement lives in a small hidden folder next to them, shared with everyone who opens the same folder. If someone moves a file in Finder or Explorer, the image moves to its new box the next time you look. For a studio that keeps pre-production art in deep folder trees, this replaces clicking through subfolders with seeing the whole tree at once, and organizing it by hand when you want to.

**Why it fits Forme:** local-first, plain files, quiet chrome where the art is the loudest thing on screen. It also pairs with Snapback (send an image for feedback) and Limn (attach an image to a card).

## 2. Principles

1. **The disk is the truth.** Folders and files are never copied into a library. The app only adds layout on top. Delete the hidden folder and you lose arrangement, never images.
2. **Teams first.** Shared folders on Google Drive and Dropbox are the main way it will be used, so several people can arrange the same board without ever creating sync conflicts.
3. **Never modify image files.** The app reads images. It only writes to disk when you explicitly move, rename, add or delete, and every such action can be undone.
4. **Instant first, perfect later.** Boxes and placeholders appear right away from file headers; thumbnails stream in by what's on screen.
5. **Stable layout.** Things you placed never jump. New files and folders find free space; nothing else moves.
6. **One look.** forme-brand tokens, the six themes, default look and Quiet mode, Limn's feel.

## 3. Canvas model

### Board, groups, items
- **Board** = one root folder. Opening a folder makes it a board.
- **Group** = one folder, drawn as a box with a header (folder name, image count). A subfolder is a group nested inside its parent's box. A folder with no images but with subfolders is just a container box.
- **Item** = one image file inside its folder's group.

### Coordinates
- Items store their position **relative to their group**, and groups relative to their parent. Moving a box moves everything in it, and a folder moved on disk keeps its internal arrangement.
- Item transform: position, scale, rotation, flip H/V, z-order. Later: crop rect, greyscale toggle.

### Two layout modes per group
- **Auto** (default): images are packed in a justified grid (row-based, aspect-preserving) that reflows when the box is resized. New files slot in by name or date.
- **Free**: absolute placement, reference-board style. Overlap, rotate, scale freely. Resizing the box only changes its frame.
- A group switches from Auto to Free the first time you drag something inside it. "Tidy" switches it back (with undo). This gives instant order for untouched folders and full control where you care.

### The first layout (treemap-like)
- On first open, top-level groups are placed with a **squarified treemap**, sized by image count (with a floor so tiny folders stay readable). Nested folders get the same treatment inside their parent.
- After that, the treemap never re-runs on its own. New folders take free space next to their siblings. "Re-layout board" exists as an explicit command (with undo).

### Depth and scale
- **Depth control:** show folders down to N levels; deeper folders fold into their ancestor's box (flattened, with a subtle sub-header per folder). Default N = 3.
- **Collapse a group** to its header strip with a short preview row, to hide what you're not using.
- **Focus a group:** double-click its header to zoom to fit; Esc to return.

## 4. Where layout lives, and staying in sync with the disk

### Built for teams on Google Drive and Dropbox (decided Nov 13)
The studio keeps its art on Google Drive and Dropbox, and several people will open the same folders. The arrangement is **shared**: anyone who opens the folder sees the same board. Sync services are good at moving files around and bad at two people editing one file at once (Dropbox makes "conflicted copy" files; Google Drive keeps one version and drops the other). So the design never has two people write the same file.

### The board folder
One hidden folder at the board root, `<root>/.<app>/` (named after the final app name), synced like everything else:

```
.<app>/
  board.json            shared snapshot: groups, items, transforms (any member may rewrite it, rarely)
  people/<device>.json  each person's own recent edits; only that device ever writes it
  thumbs/               shared 512 px previews, written by whoever has the original on disk
```

- **Each person writes only their own file.** Every edit (move, resize, rotate, group frame) goes into `people/<device>.json` with a timestamp. Because no two people ever write the same file, Drive and Dropbox never produce conflicts.
- **Reading merges everyone.** On open, and whenever the sync service updates someone's file, the app merges the snapshot and all `people/` files. For each image and each box, the newest edit wins. Two people moving different images never clash; two people moving the same image settle on whoever moved it last, and both screens agree within seconds of syncing.
- **Compaction.** When `people/` files grow large, one member folds them into `board.json` and trims their own file. If two members compact at the same moment, nothing is lost, because the merge rule is the same either way. Stray "conflicted copy" files are read in too and then cleaned up.
- **Live updates.** Teammates' edits appear on your board as their files sync, animating into place. A small avatar dot shows who moved something last (neutral grey, per forme-brand).
- Writes are debounced (about 500 ms) and atomic (write a temp file, then rename). Size: about 250 bytes per image, so 5,000 images is about 1.2 MB of snapshot.
- If the root is read-only, the person's layout stays in app data and the app says so.

### Online-only files (Drive "stream" mode, Dropbox "online-only")
On both services many files exist only in the cloud until opened, and any read downloads the whole file. A board of 2,000 large PSDs must not trigger 40 GB of downloads just to show thumbnails.

- **Detect placeholders** before reading (the dataless flag on macOS, the recall-on-access attribute on Windows) and never read them in the background.
- **Shared thumbnails.** Whoever has an original on disk writes its 512 px preview into `.<app>/thumbs/` (about 40 KB each, 80 MB for 2,000 images). Everyone else gets thumbnails through the sync service without downloading originals. Image dimensions and average color are stored in the snapshot, so the layout is correct even before any thumbnail arrives.
- **Download on demand.** An original is fetched only when someone opens it in the viewer, zooms in past the preview, or drags it out to another app. "Keep this folder on this computer" pins a folder for offline use, using the service's own setting.
- **Matching without reading.** For online-only files the app can't hash content, so it matches by path, then by name + size + modified time, and confirms with a hash once the file is local.

### Local cache (per computer)
- The full-size tiers (128 and 2048 px), the search index and anything not worth syncing live in the app's cache folder (`~/Library/Caches/…`, `%LOCALAPPDATA%\…`). They're rebuildable.

### Recognizing a file after it moves
On open and on every file-system change, the app reconciles the disk against the board file. It matches each image in this order:

1. **Same relative path**, same size and mtime → unchanged.
2. **Same platform file id** (inode + device on macOS/Linux, file index + volume serial on Windows) → renamed or moved within the same volume. This is free and catches almost every Finder/Explorer move.
3. **Same quick hash + size** (xxh3 over size + first and last 64 KB) → moved across volumes, restored from a backup, or re-synced by Dropbox/Drive, which often change file ids.
4. **Same full hash** (blake3, computed lazily only to break ties) → settles duplicates.

Then:
- **Matched in a new folder:** the image moves into that folder's box and keeps its scale, rotation and flip. Its position in the new box is the nearest free space (Free groups) or its sorted slot (Auto groups).
- **New file:** placed in its folder's box with an **unread dot** (blue is allowed for unread dots) until you've seen it. A "New since last open" filter jumps between them.
- **Missing file:** kept as a ghost for 30 days (or until you clear it) in a "Missing" list, so an unmounted drive or a temporarily moved folder comes back exactly as it was.
- **Duplicates** (same content in two places): each copy is its own item. A hash match only transfers layout when the old path is gone, preferring the same filename.

### Watching
- `notify` (FSEvents on macOS, ReadDirectoryChangesW on Windows), debounced about 300 ms, then reconcile only the folders that changed.
- Network and shared drives often don't send events, so the app also rescans changed folders when the window regains focus and polls folder mtimes every 30 s while a board on a network volume is open.
- **Cloud placeholders** (Dropbox/iCloud/Drive "online-only" files): reading them triggers a download. The app checks the platform flag (dataless on macOS, recall-on-access on Windows) and shows a cloud placeholder instead of decoding until the file is local.

## 5. Performance plan

**Targets** (Mac Studio / mid-range Windows laptop):
- 2,000 images: boxes and placeholders on screen in under 1 s on a cold open; under 300 ms warm.
- Pan and zoom at 60 fps with 5,000 images on the board.
- Cold thumbnail build for 2,000 typical JPG/PNG/PSD on an SSD: under a minute, with on-screen images first.
- Memory: GPU texture budget about 512 MB, adjustable.

### Pipeline
1. **Scan (Rust).** Parallel directory walk (`jwalk`): path, size, mtime, file id. Read **image dimensions from file headers only** (`imagesize`), which is microseconds per file. This alone gives a correct layout before any decode.
2. **Placeholders.** Each item renders as a flat tile at its true aspect ratio. As each thumbnail lands, its average color is stored so later opens show a tinted placeholder instantly.
3. **Thumbnails (Rust, background pool).** A priority queue fed by the viewport: visible, then near the viewport, then everything else. Decode at reduced size where the format allows (JPEG DCT scaling decodes at 1/2, 1/4, 1/8 directly, which is the biggest single speedup), SIMD resize with `fast_image_resize`. Tiers by longest edge: **256 and 1024** on disk, plus a **64 px atlas** tile per image made in the canvas (first build, Nov 13: chosen to keep GPU memory near 100 MB for 5,000 images; the viewer uses the original or a 2048 render). Cached on disk keyed by quick hash + size, with a size cap (default 5 GB, least-recently-used eviction).
4. **Delivery.** Rust serves thumbnails through a custom URI protocol (`thumb://<id>/<tier>`), not JSON IPC. The webview decodes them off the main thread with `createImageBitmap` and uploads to the GPU.
5. **Rendering.** A small WebGL2 renderer: every image is an instanced textured quad (position, scale, rotation, flip, texture rect). The 128 tier is packed into 4096×4096 atlas pages, so a fully zoomed-out board of thousands of images is a handful of draw calls. Higher tiers load per item as they grow on screen.
6. **Level of detail and culling.** A spatial index (`rbush`) finds what's on screen each frame. The tier is picked by on-screen size (with a little hysteresis so tiles don't flicker). Off-screen textures are released by least-recently-used order.
7. **Full resolution.** Only when an image fills most of the screen, or in the viewer. Very large files (8K concept paintings, 500 MB PSDs) are decoded once to a 4096 image; true deep-zoom tiling is a later item.
8. **UI on top.** Group headers, selection handles and menus are DOM (React) drawn over the canvas, only for what's visible. Text stays crisp, and the canvas stays simple.

### Why WebGL in the webview, not DOM or native
- DOM `<img>` with CSS transforms is fine to a few hundred images and falls apart with thousands plus rotation and zoom.
- A native wgpu renderer would be fastest but breaks the shared React/TS chrome the suite uses, and doubles the UI work.
- WebGL2 in WKWebView and WebView2 handles tens of thousands of instanced quads comfortably. The spike (M0) proves this before anything else is built, and wgpu stays as the fallback if it doesn't.

### Formats
- **MVP:** JPG, PNG, WebP, GIF (first frame), BMP, TIFF, PSD (embedded composite; Photoshop's "Maximize compatibility" files have it, others fall back to a file icon with name).
- **Later:** animated GIF playback, HEIC (via the OS on macOS), Procreate and Krita (their files contain a full preview image), Clip Studio, SVG, PDF first page, EXR, video and animatic thumbnails.

## 6. Interactions

### Navigate
- Pan: trackpad two-finger, space + drag, middle mouse. Zoom: pinch, Cmd/Ctrl + scroll, keys + and −.
- Fit board, fit selection, focus group (double-click header), back (Esc).
- Folder sidebar (collapsible tree with counts). Click a folder to fly to its box.
- Minimap (later).

### Arrange
- Select: click, Shift/Cmd-click, marquee. Select all in group.
- Move, resize with corner handles (aspect locked, Shift to unlock), rotate with a handle (snaps to 15° with Shift), flip H/V, bring forward/back.
- Arrange selection: grid, row, column, pack, match heights, match widths. Tidy group (back to Auto).
- Reset transform. Undo/redo for everything, including disk actions.

### Look
- **Viewer:** Space opens the selected image full-window; arrows step through the group; Space or Esc closes. Shows name, size, dimensions, path.
- Greyscale toggle for value checks (later, per image or whole board).

### Work with files
- Reveal in Finder/Explorer, Open in default app, Open with…, Copy image, Copy path.
- **Drag out** to Photoshop, Limn, Snapback, Slack, anywhere.
- **Drag in** from Finder or a browser onto a box: the file is copied into that folder on disk.
- **Paste** an image into a box: saved as a PNG in that folder (later).
- **Between boxes (decided):** dragging an image into another box moves the file into that folder on disk. Hold Alt/Option to copy instead. A short note confirms the move with Undo, and Cmd/Ctrl+Z puts the file back. Moving many files at once asks first. On a shared folder the move syncs to the whole team like any Finder move.
- Create folder (new box), rename folder (rename box), from the board.

### Search and filter
- Cmd/Ctrl + F (or `/`) opens a search field over the canvas.
- Matches on filename, folder path, extension, dimensions (`>4000px`), orientation (portrait, landscape, square), modified date.
- Results **dim everything else** instead of hiding it, so spatial memory stays intact. Enter and Shift+Enter fly between matches. "Show only matches" packs them into a temporary results box.
- Saved quick filters: New since last open, Missing, Large files.
- Index: SQLite in the cache folder, updated by the same reconcile pass.
- Later: search by color, find similar images (perceptual hash), find duplicates, and local semantic search ("red dragon sketch") with an on-device model.

## 7. Look and feel (forme-brand)
- Canvas is `--ui-bg`; group boxes are the next tint step with a 6 px radius, header in muted text with a count. Nested boxes step one more tint, then stay flat.
- Blue only for selection, focus, the next action and unread (new-file) dots. Missing files show as a grey dashed outline.
- All six themes. Ash and Fog matter here: mid-grey backgrounds are better for judging color, which is a real reason artists will switch.
- Quiet mode works out of the box because the images supply the color. Any new element (such as folder color labels) is added to forme-brand first.
- Window title: app name only. Never name the studio.

## 8. Tech stack

| Part | Choice |
| --- | --- |
| Shell | Tauri 2, Rust, `com.evanviera.<slug>` |
| UI chrome | React + TypeScript (shares patterns with Limn), tokens from forme-brand `ui.css` |
| Canvas | Custom WebGL2 instanced-quad renderer, `rbush` spatial index |
| Scan / watch | `jwalk`, `notify` + debouncer, network-volume polling |
| Decode / resize | `image`, `zune-jpeg` (scaled decode), `psd`, `fast_image_resize`, `rayon` |
| Identity | platform file ids, `xxhash-rust` (quick), `blake3` (full) |
| Cache / index | thumbnail files on disk + `rusqlite` |
| Release | forme-website app kit: suite update key, signed and notarized Mac, Windows installer, forme.md download links |

Rust modules kept small from day one: `scan`, `reconcile`, `watch`, `thumbs`, `board_file`, `index`, `fsops` (moves/renames with undo journal). Frontend: `canvas/` (renderer, picking, LOD), `board/` (model, layout, undo), `components/`.

## 9. Scope

### MVP (0.1)
- Open a folder as a board; recent boards.
- Scan, watch, reconcile (path, file id, hash). New-file dots, Missing list.
- Treemap first layout; nested group boxes; depth control; collapse; focus.
- Auto and Free groups; move, resize, rotate, flip, z-order; arrange selection; tidy; undo/redo.
- Thumbnail pipeline (three tiers, viewport priority), WebGL renderer, culling, LOD.
- Viewer; search and filter with dim + fly-to; folder sidebar.
- Reveal, open, copy, drag out, drag in (copies into folder).
- Shared board folder: per-person edit files, merge, compaction, live updates from teammates.
- Google Drive and Dropbox: online-only detection, shared thumbnails, download on demand.
- Move files between boxes (Alt to copy), create and rename folders, all with undo.
- Themes, Quiet mode, updater, Mac + Windows release via the app kit, forme.md page and download links.

### Next (0.2–0.3)
- Crop, greyscale, paste from clipboard, text notes on the board, minimap.
- Animated GIF playback, HEIC, Procreate, Krita.
- Send to Snapback; attach to a Limn card.

### Later
- Color search, similar images, duplicates, local semantic search.
- Video and animatic thumbnails.
- Deep-zoom tiling for huge images.
- Present mode (step through groups full-screen), export a board or group as an image or PDF.
- Boards spanning several roots.

## 10. Build order
- **M0 spike:** scanner + thumbnail pipeline + WebGL renderer against a real 5,000-image pre-production folder. Measure time to first paint, thumbnail throughput and fps on the Mac Studio and a Windows laptop. Go/no-go on WebGL.
- **M1 board folder, reconcile and sync:** stable ids, all matching steps, watcher, Missing and New, per-person edit files and merge. Tested with two computers on a shared Google Drive folder and a shared Dropbox folder: simultaneous edits, moves in Finder, online-only files, offline then back online.
- **M2 canvas editing:** groups, Auto/Free, transforms, arrange, undo.
- **M3 finding things:** search, filter, viewer, sidebar.
- **M4 ship:** app kit, secrets, icon, forme.md page, 0.1.0.

## 11. Risks
- **WebGL performance on weak Windows GPUs.** Settled by the M0 spike; wgpu is the fallback.
- **Huge PSDs and TIFFs** can take seconds and hundreds of MB to decode. Cap concurrent big decodes, decode to a bounded size, never on the UI thread.
- **Google Drive and Dropbox behavior.** Each has quirks: Drive for desktop on Windows mounts a virtual drive where file ids aren't stable, both can be slow to report changes, and both download a whole file on any read. Handled by placeholder detection, shared thumbnails, name + size + time matching and focus rescans, but this must be tested on the studio's real shared folders in M1, not assumed.
- **Two people moving the same image at the same moment.** The newest edit wins and both screens converge after sync. That's acceptable for a reference board; true real-time co-editing (seeing each other's cursors) is out of scope.
- **Moving files on a shared folder affects everyone.** Moves sync to the whole team, so Undo must work even after sync, and moving more than a handful of files asks first.
- **Clock differences** between computers could make an older edit look newer. Edits carry a logical counter as well as a time, so order stays correct.
- **Layout drift from sync tools** that rewrite files (changing mtime or id). The hash fallback covers it, at the cost of some reading.
- **Originality.** The app should stand on its own: folder boxes, disk-truth and auto/free groups are the core, with its own file format, look and interactions. Don't copy another app's UI, shortcuts table, file format or naming.

## 12. Names
Latin roots, short, like Forme and Limn (limn comes from Latin *luminare*, to illuminate; forme from *forma*). Each one still needs a check on the nic.md registry (DNS lookups are unreliable for `.md`) and an app-name search.

- **Locus** (recommended): Latin for "place". Every image shown in its place on disk. Five letters like Forme, easy to say. "Locus · Reference boards".
- **Tabula:** a board or tablet for drawing and painting on. The most literal "reference board".
- **Tavola:** the Italian descendant of *tabula* (a board, a panel painting). Sits next to Forme the way Forma did. tavola.md looked unregistered in the Oct 31 check.
- **Tessera:** a single mosaic tile; many pieces making one picture. tessera.md looked unregistered on Oct 31.
- **Mappa:** Latin for a cloth or map, the root of "map". Fits the folder map idea.
- **Cella:** a storeroom or chamber; each folder a room.

## 13. Decisions

Decided Nov 13: dragging between boxes moves files on disk (with undo, Alt to copy); the layout is shared with everyone who opens the folder; Google Drive and Dropbox team use is part of 0.1.

Still open:
1. **Name:** pick one from the list above (recommended: Locus), then confirm the `.md` domain on nic.md.
