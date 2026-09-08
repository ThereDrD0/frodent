---
name: ryadom-frontend
description: Maintain the minimal Ryadom board frontend, IndexedDB attachments, local tab collaboration and existing C++ snapshot integration. Use for board UI and integration planning in this repository; do not modify the sibling backend.
---

# Ryadom board frontend

## Scope

The current product is a minimal Miro-like board, superseding the old notes editor. Keep the existing directory spelling `frondent`, local `master` history, Russian Conventional Commits and English maintenance notes. The user's minimum 125 non-empty commits has already been met across the project; keep committing subsequent meaningful changes. Do not download tools, use cloud design services, deploy, push, install packages or modify the sibling C++ source.

The previous notes localStorage key `ryadom.notes.v1` belongs to the user. Never clear or migrate it implicitly. Old UI source is recoverable from Git history.

## Architecture

No runtime or build dependencies. `index.html` owns the small accessible shell; `src/board.css` styles the canvas and floating controls; `src/board.js` owns input, rendering, local presence and operation history. `board-model.js` owns object validation and camera math. `board-storage.js` owns IndexedDB transactions; `board-files.js` validates attachments and handles downloads. `board-backend.js` uses the actual C++ email/password login and note snapshot endpoints.

Read [design](../../../docs/DESIGN.md) for visual work and [backend contract](../../../docs/BACKEND_BOARD.md) for integration. Prefer adding actions to the existing contextual controls/dialog, not more persistent panels.

## State and concurrency

The database is `ryadom-board-v1`, with objects/files/meta stores. Objects are committed with compare-and-swap revisions. Never write the entire local board array over another tab's state. BroadcastChannel provides ephemeral previews/presence and notifications; IndexedDB is the durable authority. Refresh from IndexedDB after tab visibility changes. Deleted objects remain tombstones for undo; attachment Blobs are retained for restoration.

Multiple tabs are a local demo, not multiple remote users. Do not invent participants or claim network synchronization. The current C++ API supports immutable snapshots only. Never background-PATCH the whole board. Remote operations, server file transfer, actual membership and realtime transport require the backend work in the linked handoff.

Text editing uses plaintext-only contenteditable and textContent. Keep cursor/IME behavior intact. Preserve concurrent text conflicts as separate objects and keep a session draft until persistence succeeds. Own undo revisions must not be misidentified as remote edits; stale undo must never replace a remote revision.

## Files and exports

Drag/drop, file picker and clipboard share one insertion path. Raster images render through local Blob URLs; documents render safe metadata cards and download without execution. SVG/HTML uploads are unsupported. Original static SVG assets in assets/ are trusted project files, not user-provided SVGs.

Blobs and object references commit in one transaction. Retain unsaved file data in memory so an export can recover a clipboard image after storage failure. Report failure truthfully. Local backup exports include attachments up to 35 MiB total; server snapshots strip blobId and mark missing originals. Import validates inputs before adding anything and creates fresh IDs; never overwrite the current board. Honor 20 MiB/file, ten files/insertion, 1000 visible objects and 20000 text characters/object.

## Material 3 and local launcher

Reuse semantic `tokens.css` from matugen's `#4EF5E7` palette in both themes. Never run matugen without `--dry-run`. Offline Qt Material source references are recorded in DESIGN.md. Keep original vector assets and local fonts; no remote asset requests.

`start.mjs` launches the existing backend and frontend, or just the board with `--frontend`. Its private ignored runtime config preserves the C++ relative config path without touching source files. Keep services loopback-only and stop only owned child processes. Forward the selected BACKEND_PORT to the static server. That server allows only the explicitly implemented login/new-snapshot/read-snapshot API routes; do not proxy arbitrary paths or destinations.

## Validation

Run `npm test` for model, file and contrast checks. Run `scripts/launcher-test.mjs` and `scripts/proxy-test.mjs` for isolated localhost fixtures. Browser checks use preinstalled Playwright and a fresh profile via `scripts/board-test.mjs`; set BOARD_TEST_ORIGIN to an owned test port if the default is already used. Never stop an existing user's server to reuse its port.

Test actual file drop/paste, reload, two-tab drawing and conflicting text, undo/redo, object resize, export/import and API error handling. Inspect desktop/mobile screenshots and both themes. Record exact limits in TESTING.md. Native downloads in headless Vivaldi are not covered by Blob capture. A mocked API pass does not verify the real C++ binary or PostgreSQL.
