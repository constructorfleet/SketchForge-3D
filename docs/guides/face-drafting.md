---
slug: "/docs/guides/face-drafting"
title: "Face drafting"
audience: "Editor users"
owner: "Editor"
sources:
  - "packages/sketchforge-engine/src/**"
---

# Face drafting

Face colours and face drafts live in the **Faces** panel of the shape
inspector. Both act on one face at a time, chosen with the **Face** stepper.
Faces are numbered from 1, and the panel shows how many the shape has. While
the pointer is over the panel, the chosen face is highlighted in the view, or
shown in its own colour if it has one.

## Enable face editing

A solid built from a shape's own parameters, such as a box, cylinder, cone,
sphere or torus, has no exact faces yet. Its **Faces** panel offers
**Enable face editing**, which rebuilds the shape in place as exact solid
geometry, the same kind a fillet or chamfer produces. Its size stays editable,
but settings that belong to the shape type, such as the number of sides, become
fixed. The step is undoable. Sketch extrusions, sweeps, filleted or chamfered
shapes and STEP imports already have exact faces, so the panel opens on the
face tools directly. Holes, text, groups, imported pictures and plain meshes
do not offer it. A shape turned any way, including one tilted about a
horizontal axis, is rebuilt exactly where it stands.

![The Faces panel after enabling face editing on a box, with one face coloured.](../screenshots/face-tools.png)

## Colour a face

Choose a face, then pick a colour. Coloured faces are listed under the
picker. Selecting a row jumps to that face, and its remove button clears the
colour. Colours are stored per face, show in the viewport, and are written to
3MF exports.

## Draft a face

Face drafting tapers the chosen face, as if the part were pulled out of a mold
in the chosen **Direction**. Choose the direction and a non-zero **Draft angle**
strictly between -45° and 45°, then **Apply draft**. Combinations that would
not give a valid solid are refused with a message, and the shape is left as it
was. A successful result is baked geometry: it replaces the source shape,
receives new face IDs, and does not keep face colours or edge-treatment
metadata.

The pull direction is ±X, ±Y (up and down), or ±Z in the solid's own frame.
Choosing the opposite direction can expose draft cases on the other side of a
part. Axis availability does not mean every face and angle works with every
axis.
Measured cases below come from the editor-plane 20 × 20 mm square profile
extruded 10 mm along +Y, then physically rotated in the B-rep before drafting.
Face numbers refer to the kernel's face listing for that fixture, not semantic
labels that transfer to other solids. The listing counts from 0 and the
**Faces** panel from 1, so listing index 0 is face 1 in the panel.

| Pull axis | B-rep orientation | Face listing index | Draft angles verified |
| --- | --- | ---: | --- |
| +X | Rotated +90° around local Y | 0 | -30°, +30° |
| +Y | Rotated -90° around local X | 2 | +10° |
| -X | 10 mm box | 0 | +5°, +30° |
| -Y | 10 mm box | 2 | +5°, +30° |

The 10 mm box has also been verified for faces 0–3 at ±5° and ±30° along +Z
and -Z. The unrotated editor-plane extrusion fixture has also been verified for
faces 1, 3, 4, and 5 at ±5° along +Z. These are narrow acceptance samples, not a guarantee for other
faces, dimensions, solids, axes, or angles. For example, face 1 at -5° is
rejected along +X and +Y on the unrotated extrusion fixture.

Automated kernel coverage lives in `tests/e2e/draftFaceEditor.e2e.ts`. Two
browser acceptance flows cover the editor. `tests/browser/face-drafting.test.mjs`
creates the default rectangular sketch extrusion, chooses face 2, the +Z pull
direction and a -5° angle, and applies the draft from the **Faces** panel.
`tests/browser/face-tools.test.mjs` adds a plain box, enables face editing,
checks the chosen face is highlighted, colours it, and drafts it. Both wait for
the editor's success status before capturing the result.

![A supported face draft applied from the editor inspector.](../screenshots/face-draft-browser.png)

Run the acceptance flow after building the app with `npm run test:browser`.
The inspector operation is local to the editor; it does not create a
rebuildable feature-history node or a REST/client operation.
