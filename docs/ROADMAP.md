---
slug: /docs/ROADMAP
title: Roadmap
audience: Contributors
owner: Contributors
---

# Roadmap

This page summarizes active tracked work. Issue status remains authoritative.

## Dependency maintenance

- [#397: Keep Vitest's mocker out of production installs](https://github.com/constructorfleet/SketchForge-3D/issues/397) — security dependency fix.
- [#398: Plan major dependency upgrades](https://github.com/constructorfleet/SketchForge-3D/issues/398) — spike candidates after maintainers choose sequencing; keep the CAD kernel pair gated on STEP round-trip e2e and engine performance checks.

## Project storage durability

Tracked under [epic #324](https://github.com/constructorfleet/SketchForge-3D/issues/324).

- [#332: Surface autosave failures while editing](https://github.com/constructorfleet/SketchForge-3D/issues/332) — P0, open.
- [#336: Secure local folder downloads](https://github.com/constructorfleet/SketchForge-3D/issues/336) — P0, open.

## API request safety

Tracked under [route security epic #325](https://github.com/constructorfleet/SketchForge-3D/issues/325).

- [#338: Enforce request body size limits on REST routes](https://github.com/constructorfleet/SketchForge-3D/issues/338) — P2, open.

## Geometry placement

- [#424: Keep server treatments in place on tilted shapes](https://github.com/constructorfleet/SketchForge-3D/issues/424) — P2, open.

## Editor parity with engine and API

Tracked under [epic #329](https://github.com/constructorfleet/SketchForge-3D/issues/329).

- [#380: Interference check and wall-thickness analysis in the editor](https://github.com/constructorfleet/SketchForge-3D/issues/380) — P2, implemented and in review.

## CAD geometry correctness

- [#435: Keep retained drafts in place across draft growth and rotated sketch edits](https://github.com/constructorfleet/SketchForge-3D/issues/435) — implementation and regression coverage in progress.
- [#412: Preserve non-uniform resize in face-draft paths](https://github.com/constructorfleet/SketchForge-3D/issues/412) — P2, implementation and regression coverage in progress.
- [#436: Preserve mirrors in REST face and prism drafts](https://github.com/constructorfleet/SketchForge-3D/issues/436) — implementation and regression coverage complete; awaiting merge.
