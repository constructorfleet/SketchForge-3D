---
slug: "/docs/guides/face-drafting"
title: "Face drafting"
audience: "Editor users"
owner: "Editor"
sources:
  - "packages/sketchforge-engine/src/**"
---

# Face drafting

Face drafting tapers one selected face of an exact B-rep solid. In the shape
inspector, choose the CAD face index, a local CAD pull axis, and a non-zero
draft angle strictly between -45° and 45°, then apply the operation. The kernel
rejects combinations that do not produce a valid solid. A successful result is
baked geometry: it replaces the source shape, receives new face IDs, and does
not keep face colors or edge-treatment metadata.

The pull-axis selector accepts ±X, ±Y, and ±Z in the solid's local CAD frame.
Choosing the opposite direction can expose draft cases on the other side of a
part. Axis availability does not mean every face and angle works with every
axis.
Measured cases below come from the editor-plane 20 × 20 mm square profile
extruded 10 mm along +Y, then physically rotated in the B-rep before drafting.
Face numbers refer to the kernel's face listing for that fixture, not semantic
labels that transfer to other solids.

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

Automated kernel coverage lives in `tests/e2e/draftFaceEditor.e2e.ts`. The
inspector operation is local to the editor; it does not create a rebuildable
feature-history node or a REST/client operation.
