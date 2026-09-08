---
name: ryadom-frontend
description: Maintain the offline Ryadom notes frontend, Material 3 styling, browser persistence and Markdown behavior in this repository. Use for frontend changes and integration planning; do not modify the sibling C++ backend.
---

# Ryadom frontend

## Scope and architecture

The existing directory is spelled `frondent`; preserve it. It has an independent Git repository on `master`. Keep English implementation notes here and Russian product copy/commit descriptions. The delivery requires at least 125 non-empty microcommits; prefer meaningful component or behavior boundaries. No remotes, deployment, downloads or system changes are authorized.

There are no runtime or build dependencies. `npm start` runs a loopback-only Node static server on port 4173. `index.html` contains the semantic shell; `src/app.js` binds interactions, `src/store.js` validates and selects notes, `src/markdown.js` safely renders the supported subset, `src/seed.js` contains explicitly local editable examples, and `src/icons.js` owns original SVG icons.

Read [design decisions](../../../docs/DESIGN.md) for visual changes and [backend handoff](../../../docs/BACKEND_HANDOFF.md) before integration work. These relative links resolve from this skill directory to repository documentation.

## Behavioral invariants

- The current product is local, not a connected multiuser client. Do not invent collaborators or label local writes as server synchronization. Sharing currently offers Markdown export and explains the limitation.
- Persist every input synchronously. Do not let filtering, switching modes, changing notes or navigation lose the last edit. Never overwrite corrupt stored data with seeds. Empty arrays are valid persisted collections.
- Another tab's storage event blocks writes until reload; preserve the current in-memory draft for export. This is a conservative safeguard, not a multiuser conflict-resolution protocol.
- Soft deletion is reversible. The C++ DELETE endpoint is permanent and must not be wired to this action. Favorites are per-user local state and the sidebar shows at most five.
- Render untrusted content through `renderMarkdown`/`escapeHTML`. Raw HTML, remote images and executable URLs are unsupported. Preserve literal fenced and inline code. Checkbox source line indices must remain correct.
- Theme persistence failure must not prevent editing. Storage failure must never display successful saving; retain the draft and offer export.

## Design maintenance

Use semantic variables in `src/tokens.css`. They were generated using `matugen --dry-run -j hex color hex '#4EF5E7'`; `docs/palette.json` records the actual output. Never run matugen without `--dry-run` in this task context. Preserve both themes, responsive drawer, keyboard focus, native dialog and reduced-motion behavior. Local Qt Material source references are listed in the design document; no network is needed.

## Validation

Run `npm test` for renderer, persistence and contrast checks. For interactions, start the local server and run `scripts/browser-test.mjs` with `PLAYWRIGHT_MODULE` and `BROWSER_PATH` pointing to already installed tools. The script must not download a browser or use a user's live profile. Only localhost requests are permitted. Inspect screenshots in ignored `test-results/`, especially at narrow widths and in dark mode. Record actual results and limits in `docs/TESTING.md`; do not claim browser tests passed if the browser did not launch.
