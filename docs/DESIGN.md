# Material You 3 — board design

The board supersedes the note editor. The user requested fewer UI elements: there is no sidebar, notes list, inspector, minimap, workspace dashboard or fabricated team. Most of the viewport belongs to the canvas.

## Offline references

Previously inspected local ready-made Material implementations remain the source for shape, state and modal behavior:

- `/usr/lib/qt6/qml/QtQuick/Controls/Material/Button.qml`
- `/usr/lib/qt6/qml/QtQuick/Controls/Material/TextField.qml`
- `/usr/lib/qt6/qml/QtQuick/Controls/Material/Dialog.qml`
- `matugen --help`, matugen 4.2.0 and the saved generated palette in `palette.json`.

The installed Dialog implementation references https://m3.material.io/components/dialogs/specs and https://m3.material.io/components/dialogs/guidelines. These URLs were recorded, not fetched. No Qt code was copied and no web/cloud design tool was used.

## Composition and colors

A small title/menu surface anchors the top left, collaboration status lives at the top right, a vertical tool rail sits left and zoom/history sits bottom right. A contextual object strip appears only for a selection. Mobile turns the tools into a short bottom bar; empty-space dragging and pinch keep navigation available without a dedicated hand button.

Use the existing semantic light/dark tokens generated with `matugen --dry-run -j hex color hex '#4EF5E7'`. No system colors, templates or hooks were changed. Tonal containers color the sticky notes; primary supplies selection, cursor and drawing strokes; tertiary supplies a second accessible accent. Floating controls use low surfaces, rounded shapes and restrained elevation. The dot grid uses outline-variant.

Original assets: the existing adjacent-strokes logo, extended 24px SVG icons and `assets/landscape.svg`, a hand-drawn vector landscape composed of hills, sky and a sun. The initial board contains real editable sample objects. It does not show fictional online users. Uploaded images use original file bytes.

## Interaction

Plain-text editing avoids executing pasted HTML. Tool shortcuts are documented in the help dialog. Pointer capture supports dragging; hit testing for double-click uses the actual element under the pointer. Image resize preserves aspect ratio. Ctrl/Command+wheel anchors zoom to the pointer; two touch pointers support pinch/pan. Selection actions use native buttons and names; reduced-motion users do not get transition animations.

The collaboration dialog explains local versus remote behavior and contains the existing C++ snapshot workflow. Technical details stay out of the canvas itself. The product is not a full Miro replacement: no connectors, frames, nested boards, rich document editor or remote CRDT is claimed.
