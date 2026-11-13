# Locus — notes for AI agents

Folders shown as boxes on one canvas, images arranged freely inside. Tauri 2 (Rust) + React/TypeScript, part of the Forme suite. Design and decisions: `docs/plan.md`.

## Where code lives

- `src-tauri/src/` — `lib.rs` (setup, `thumb://` protocol, IPC commands), `scan.rs` (walk + header sizes), `thumbs.rs` (decode, tiers, cache, shared team previews), `layout_store.rs` (per-device layout files, merge, follow moved files), `fsops.rs` (move/copy/import), `watch.rs`, `menu.rs`, `tests.rs`.
- `src/lib/` — `board.ts` (model + Auto/Free layout), `pack.ts`, `session.ts` (saving, undo, file moves), `mockBackend.ts` (browser build), `prefs.ts`.
- `src/canvas/` — `renderer.ts` (WebGL2 instanced quads), `textures.ts` (atlas + tiers + load queue), `scene.ts` (camera, culling, picking, dragging, overlay).
- `src/components/` — React chrome, prop-driven.
- `src/styles.css` — `@import` barrel; real CSS in `src/styles/*.css`.

## Rules

- The disk is the truth. Never modify image files; only move/copy/add when the person asks, always with undo.
- Each computer writes only `.locus/people/<its device id>.json`. Never write another device's file, and never empty your own file except through `trim_own` (records the snapshot already holds).
- Never read an online-only (cloud placeholder) file in the background. Only the viewer's `full` tier may download one.
- Keep files under ~600 lines; split before they grow (new UI in `src/components/`, logic in `src/lib/` or `src/canvas/`).
- Relative value imports use a `.js` extension; type-only imports omit it.

## Branding

Follow **[evanviera/forme-brand](https://github.com/evanviera/forme-brand)**. `src/styles/tokens.css` is a copy of its `tokens/ui.css`; change forme-brand first. Blue only for the next action, selection, focus and unread (new-file) dots. Never name the studio behind the apps. Before finishing visual work: `node scripts/check.mjs ../locus` from a forme-brand checkout.

## Verify after changes

```sh
npm run build:web && npm run test:unit
(cd src-tauri && cargo test)
npx playwright test     # in the cloud: PW_CHROMIUM=/opt/pw-browsers/chromium
```
