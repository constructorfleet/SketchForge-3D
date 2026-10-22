---
slug: /docs/guides/sketch-constraints
title: Constrain sketch geometry
audience: Editor users
owner: Editor
sources:
  - "apps/web/src/**"
---

# Constrain sketch geometry

Sketch constraints relate selected entities while you edit a sketch. This guide
shows the verified **Parallel** constraint on two sides of a rectangle.

## Make two segments parallel

1. Create a sketch with at least two line segments, or edit a rectangular
   sketch.
2. Select the two segments. For the rectangle, drag a selection marquee over
   the two opposite vertical sides.
3. Choose **Parallel** in the sketch constraint toolbar.

The constraint aligns the segments' directions. It does not move the segments
to the same line or change their offset, so the opposite sides stay separated.
The workflow below checks that the two segments are selected, applies the
constraint, and confirms the resulting constraint in the editor.

![Two opposing sketch segments selected with the Parallel constraint applied.](../screenshots/sketch-parallel-constraint.png)

Run the browser acceptance flow with:

<!-- runnable-exempt: This command runs the browser acceptance workflow; its maintained implementation is tests/browser/sketch-parallel-constraint.test.mjs. -->
```sh
npm run test:browser
```

For the full create-and-export walkthrough, see [make and export your first
model](./editor-quickstart.md). For constraints on solid faces, see the
[face-drafting guide](./face-drafting.md).
