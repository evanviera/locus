# Locus

Locus · Reference boards from your folders.

Open any folder and see every image in it, and in every folder below it, on one canvas. Each folder is a box, sub-folders are boxes inside it, and inside a box you arrange images freely: move, resize, rotate, flip. Nothing is packaged or copied. Images stay where they are on disk; the arrangement lives in a small hidden `.locus` folder next to them, shared with everyone who opens the same folder on Google Drive, Dropbox or a server.

Part of the [Forme](https://forme.md) suite. Branding follows [evanviera/forme-brand](https://github.com/evanviera/forme-brand).

## Using it

| Do | How |
| --- | --- |
| Pan | Two-finger scroll, Space + drag, or middle mouse |
| Zoom | Pinch, ⌘ + scroll, mouse wheel, `+` / `-` |
| Fit board / selection | ⌘0 / `F` |
| Jump to a folder | Click it in the Folders list, or double-click its box's name |
| Select | Click, Shift-click, or drag a box around images |
| Arrange | Drag images. The first drag turns the box from **Auto** (a tidy grid) into **Free** |
| Resize / rotate | Corner handle / top handle (Shift snaps rotation to 15°) |
| Flip / reset | `H`, `V`, `R` |
| Move a file to another folder | Drop the image on that folder's box (Alt/Option copies instead) |
| Tidy a box | Right-click the box > Tidy |
| Look closely | Double-click or Enter. Arrows step through the folder |
| Find | ⌘F or `/`, then Enter / Shift+Enter to fly between matches |
| Undo / redo | ⌘Z / ⇧⌘Z (including file moves) |

## How the board is stored

```
<your folder>/.locus/
  board.json            shared snapshot
  people/<device>.json  each computer's own edits (only that computer writes it)
  thumbs/               small shared previews, so teammates don't download originals
```

Each computer writes only its own file, so sync services never see two people editing one file. Locus merges all of them; the newest change to each image wins. Images that move on disk are recognised by file id, then by name and size, and keep their size and rotation in their new box. See [docs/plan.md](docs/plan.md) for the full design.

## Develop

```sh
npm install
npm run tauri:dev          # the app
npm run dev:vite           # the canvas in a browser, on a generated board (?n=3000&stats)
```

## Verify

```sh
npm run build:web                      # tsc + vite build
npm run test:unit                      # layout tests
(cd src-tauri && cargo test)           # scan, thumbnails, shared layout, file moves
npx playwright test                    # canvas e2e on the browser build
(cd src-tauri && cargo test --release -- --ignored speed --nocapture)   # speed check
```

## Release

Same as every Forme app (forme-website `app-kit/README.md`): set the secrets once with `app-kit/setup-secrets.sh evanviera/locus`, then `npm run release:version -- X.Y.Z`, commit, and run the Release workflow with that version.
