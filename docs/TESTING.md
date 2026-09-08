# Board verification — 2026-09-08

This report supersedes the earlier notes-editor report. The board is the current frontend; old note storage was not modified.

## Environment

Reused preinstalled Node.js 26.8.1, matugen 4.2.0, Playwright 1.63.0-alpha-2026-08-31 from the existing local npm cache and the installed Vivaldi binary in headless Chromium mode. No packages were installed, no system update occurred, no external website or cloud service was used. Source changes are confined to this frontend.

Port 4173 was occupied by an existing process, which was left untouched. The owned test server used 127.0.0.1:4187 and was stopped after verification. Browser tests used disposable profiles, disabled background networking/external DNS and rejected non-localhost requests.

## Passed automated checks

`npm test`: eight model/file test groups and two color test groups:

- Seed/new object schema, unique IDs, malformed coordinates and oversized text.
- Cursor-anchored zoom and limits, fit camera, normalized stroke coordinates.
- Snapshot format, duplicate IDs and removal of local Blob IDs from server snapshots.
- Image/document whitelist, active SVG rejection, empty/oversized attachment rejection.
- Light/dark text contrast for the tested semantic pairs (at least 4.5:1, not a complete accessibility audit).

`node scripts/launcher-test.mjs`: launches two isolated fixture processes from an arbitrary working directory, preserves the original fixture backend config, creates a private loopback-only copy, handles occupied ports without killing their owner, stops owned processes on SIGINT/SIGTERM and cleans temporary configuration. Unexpected child exit and invalid parameters are covered.

`node scripts/proxy-test.mjs`: verifies the actual local proxy against a mock backend: email login, JSON snapshot body, Bearer forwarding, numeric snapshot route, route allowlist, private-file rejection, cross-origin write rejection, CSP and 503 when the upstream is unavailable.

Browser command:

```sh
PLAYWRIGHT_MODULE=/home/user/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs \
BROWSER_PATH=/opt/vivaldi/vivaldi-bin \
BOARD_TEST_ORIGIN=http://127.0.0.1:4187 \
node scripts/board-test.mjs
```

The full browser suite passed:

- Creation/editing of sticky text, actual sequential typing of tool-shortcut letters without activating tools, reload persistence.
- Object drag, undo/redo, pen strokes and rectangles.
- Literal pasted HTML remains text; no script node is created.
- Actual DataTransfer PNG/PDF drop, ClipboardEvent document paste, image bytes recovered after reload.
- Two independent tabs see new strokes; conflicting edits to one text preserve both variants.
- Image resize, reversible deletion, zoom, full backup containing three original file Blobs and non-destructive import.
- Client login/snapshot workflow against mocked responses matching the existing C++ envelope, Bearer use, token absent from durable browser storage and file references omitted from server snapshots.
- No page overflow at 320, 390, 768 and 1440px; mobile tools, collaboration explanation and light/dark themes.
- Zero external page requests and zero page-level JavaScript exceptions during the tested flow.

## Visual review

Generated and inspected desktop/mobile screenshots. Fixed selection palette rules that accidentally applied to objects, separated canvas/tool selectors, enabled plaintext typing without shortcut interception, prevented browser-managed canvas scrolling and made resize handles functional. Current reference screenshots are generated in a separate clean browser context:

- `test-results/board-desktop-light.png`
- `test-results/board-desktop-dark.png`
- `test-results/board-mobile-light.png`
- `test-results/board-mobile-dark.png`

The files are generated artifacts and ignored by Git. SVG source assets are tracked.

## Limits of the evidence

The actual C++ server is still blocked by missing dynamic libraries and an unprepared/unchecked PostgreSQL environment. No real backend account or database was modified. Mock contract and proxy tests do not establish that the real backend works.

Realtime collaboration is implemented only between tabs sharing the same IndexedDB/browser origin. Different users/devices, remote cursors, server attachment upload, authenticated rooms and CRDT/OT text merging remain backend/integration work described in BACKEND_BOARD.md.

The headless Vivaldi download manager does not emit the expected native download event. Tests validate the generated export Blob, original attachment content and re-import of the complete board; native download completion is not claimed. Clipboard tests use browser ClipboardEvent/DataTransfer; support for files copied from an OS file manager depends on what that browser exposes. Touch pinch and screen-reader behavior were not independently automated in this run; desktop pointer behavior and mobile layout were checked.

No packages were installed, so nothing requires uninstallation. The local master history has more than the user's required 125 non-empty commits and no remote. Skill metadata and relative documentation links were checked locally; the optional Python validator remains unavailable without PyYAML.
