# Changelog

## Unreleased

- Added interface localization in English, Czech, German, Spanish, French, Polish, Brazilian Portuguese and Russian. The language follows the system by default and can be changed in Settings → Language; the desktop tray and update dialogs follow the same choice. Local server errors and editor notices are translated as well; MCP tool results stay in English. Languages are ICU JSON catalogs (see `docs/TRANSLATIONS.md`); the non-English translations were made with AI help and have not been reviewed by native speakers yet.
- Added a Loft primitive that morphs a solid between two 2D cross-sections. Each end is an Oval, Rectangle, Triangle, Pentagon, or Hexagon with independent size and rotation, the way cone's Top Radius works independently of its base. Wired into `.skf` projects and the MCP bridge's `sketchforge_create_shape` as `kind: "loft"`.
- Replaced the corner rotate-handle icons with three world-space coloured axis rings as the primary rotation control on desktop. Near edge-on rings tip up slightly so they stay hittable, and opacity eases for hover, active drag, and camera motion. The corner icons remain as a fallback on touch and narrow viewports, a "Use classic rotate handles" setting forces them everywhere, and `?rotationMode=classic|rings` overrides both.
- Added a Center view on selection button next to Home, bound to Shift+F. It keeps the current viewing direction, moves the orbit target to the middle of the selection, and backs off far enough for the selection to fit, changing distance for a perspective camera and zoom for an orthographic one.
- Added a Center on workplane button to Arrange, which places the selection in the middle of the build plate. The selection moves as one so several objects keep their relative spacing, locked objects stay put and stay out of the bounding box, and an already-centred selection records no history entry.
- Arrow keys now move the selection towards the workplane axis closest to the direction the arrow points on screen, instead of along fixed world axes. The Front view and the default home view keep the mapping they always had, steps stay on an axis with no diagonals, and Ctrl/Cmd+arrow elevation changes and workplanes laid on a face are unaffected.
- The workplane now carries its name flat along its near edge, so which edge is the front is readable at a glance instead of having to be inferred from the symmetric axis lines. This also tells you which way an arrow-key nudge will move the selection, since those keys follow the plane's axes.
- Arrow keys now move the selection by the Snap Grid instead of a fixed millimetre, so a keyboard nudge lands on the same lattice a pointer drag snaps to. Shift keeps its coarser step, and the old 1mm/5mm steps stand when the grid is off. At the default 1.0 mm grid nothing changes.
- A snap grid or workspace setting chosen from a control now reaches the editor and the saved project immediately, instead of being swallowed until an unrelated change.
- Dimension marks now keep a minimum screen distance from the edge they measure, so a width or depth label is no longer hidden under a rotate handle when zoomed out. The rotate handle's hit area shrank from 52px to 40px around its 26px glyph, and dimension labels now sit on the same layer as the transform handles.
- Closing the window now quits SketchForge on Linux, where a system tray cannot be relied on. Windows and macOS keep hiding to the tray. A desktop that provides no tray no longer blocks startup, and the Linux launcher entry gained `GenericName`, `Keywords`, and `StartupWMClass`.
- Moved the project name field out of the tool ribbon and into the tab row above, so the Visibility, Combine, Modify, Arrange, and Manage groups stay reachable without the ribbon's horizontal scrollbar at narrower window widths.
- The Fillet toolbar marker and the shape inspector's length units are now keyed on property configuration rather than on visible English label text, so both keep working when the interface is translated.
- Generated button tooltips now refresh when the accessible name changes, so toggles such as Lock and Hide no longer describe the opposite action after being clicked. Tooltips written in the markup are still left alone.
- The rotate handle now shows a pointer cursor on hover instead of the canvas orbit cursor.
- Imported STL, OBJ, and SVG models now land on the workplane centre instead of a fixed 10mm offset.
- Arrow-key holds (including Ctrl/Cmd+arrow elevation changes) now finish as one undo step and one save on release. Separate taps remain separate undo steps.
- Reduced autosave work after transforms by sharing CAD display edges across undo states and reusing immutable mesh, B-Rep, and image encoding.
- Added `.skf` format 2 shared display-edge assets, with continued reading of format 1 packages and legacy JSON projects. New saves require the updated reader.

## 1.0.9

- Corrected Top and Bottom camera views so they align exactly with the vertical axis in both perspective and orthographic projection.
- Added Ctrl/Cmd + right-button panning in Sketch mode while preserving middle-button panning.

## 1.0.8

- Duplicated objects now stay in the exact position of their source instead of receiving an automatic offset.
- Added geometry shortcuts: `R` rotates selected objects by 45 degrees and `Shift+R` rotates them by 22.5 degrees around the active workplane normal.
- Corrected rotation controls so objects turn in the direction indicated by the pointer on every rotation plane.
- Kept selection outlines, resize anchors, and height controls stable during close zoom while naturally hiding controls that leave the viewport.
- Kept object faces visible from inside the object and hid rotation controls while the camera is inside the selection.

## 1.0.7

- Raised the supported `project.json` size in `.skf` packages from 32 MiB to 64 MiB and compacted new project exports without removing editable data.
- Reused decoded derived-mesh data across restored history states to reduce memory pressure when opening large `.skf` projects.
- Prevented workspace-only changes from advancing the persisted shape revision and replacing newer live objects with an older snapshot.

## 1.0.6

- Fixed dense STL imports failing with `Invalid string length` while creating their initial undo-history fingerprint.
- Streamed large numeric mesh arrays into deterministic hashes instead of converting millions of coordinates to one oversized JSON string.

## 1.0.5

- Made the rotation handles larger and aligned their arrow glyphs with the model faces as the camera moves, including stable behavior on long objects.
- Positioned the lower rotation handle consistently at the model base and corrected its visual and drag directions.
- Added an optional **Select before moving** workspace setting so the first click selects an object without immediately dragging it.

## 1.0.4

- Fixed imported STL objects briefly appearing and then vanishing when a stale IndexedDB project read completed after the import.
- Prevented older persisted project data from overwriting newer live editor state during asynchronous project hydration.

## 0.1.0

- Initial open-source alpha.
- Browser-based 3D workspace with primitive shape editing.
- STL import and STL/OBJ export.
- Grouping and hole subtraction workflows.
- Local project dashboard with generated thumbnails.
