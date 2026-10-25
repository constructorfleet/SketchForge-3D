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
- [#398: Plan major dependency upgrades](https://github.com/constructorfleet/SketchForge-3D/issues/398) — nine package-major spikes are tracked separately; see [the upgrade spike plan](DEPENDENCY_UPGRADES.md). Keep the CAD kernel pair gated on STEP round-trip e2e and engine performance checks.

## Project storage durability

Tracked under [epic #324](https://github.com/constructorfleet/SketchForge-3D/issues/324).

- [#332: Surface autosave failures while editing](https://github.com/constructorfleet/SketchForge-3D/issues/332) — P0, open.
- [#336: Secure local folder downloads](https://github.com/constructorfleet/SketchForge-3D/issues/336) — P0, open.

## API request safety

Tracked under [route security epic #325](https://github.com/constructorfleet/SketchForge-3D/issues/325).

- [#338: Enforce request body size limits on REST routes](https://github.com/constructorfleet/SketchForge-3D/issues/338) — P2, open.

## API contract accuracy

- [#366: Declare the projectId query on align and distribute](https://github.com/constructorfleet/SketchForge-3D/issues/366) — implementation and contract regression coverage complete; awaiting review.
- [#373: Add limit and cursor paging to project and shape listings](https://github.com/constructorfleet/SketchForge-3D/issues/373) — implementation and route/client coverage complete; awaiting review.

## Client command line

- [#374: Add direct project, import, and export commands to the macro CLI](https://github.com/constructorfleet/SketchForge-3D/issues/374) — implementation, generated reference, and mocked-server coverage complete; awaiting review.

## MCP bridge

- [#368: Remove editor-only fields from local MCP tools](https://github.com/constructorfleet/SketchForge-3D/issues/368) — implementation and tests complete; awaiting review.

## MCP host filesystem safety

- [#339: Confine MCP host file access and refuse silent overwrites](https://github.com/constructorfleet/SketchForge-3D/issues/339) — implemented on `security/339-mcp-filesystem-root`; awaiting review.
- [#365: Import STL, OBJ, and SVG files through the MCP bridge](https://github.com/constructorfleet/SketchForge-3D/issues/365) — implemented on `feat/365-mcp-import-obj-svg-stack`; awaiting review.

## Editor parity with the engine and API

Tracked under [epic #329](https://github.com/constructorfleet/SketchForge-3D/issues/329).

- [#379: Shell and tray (hollow) operation in the shape inspector](https://github.com/constructorfleet/SketchForge-3D/issues/379) — P2, implemented with browser coverage; in review.

## Geometry placement

- [#424: Keep server treatments in place on tilted shapes](https://github.com/constructorfleet/SketchForge-3D/issues/424) — P2, open.

## Editor parity

Tracked under [epic #329](https://github.com/constructorfleet/SketchForge-3D/issues/329).

- [#378: Explode imported STEP assemblies from the shape inspector](https://github.com/constructorfleet/SketchForge-3D/issues/378) — P2, implemented and in review.
- [#380: Interference check and wall-thickness analysis in the editor](https://github.com/constructorfleet/SketchForge-3D/issues/380) — P2, implemented and in review.
- [#386: Cover the core editor workflows in browser tests](https://github.com/constructorfleet/SketchForge-3D/issues/386) — browser regressions now cover file import/export, boolean hole grouping, edge treatments, pattern, mirror, align, distribution, prism draft and touch; implementation is ready for review.

## CAD geometry correctness

- [#435: Keep retained drafts in place across draft growth and rotated sketch edits](https://github.com/constructorfleet/SketchForge-3D/issues/435) — implementation and regression coverage in progress.
- [#412: Preserve non-uniform resize in face-draft paths](https://github.com/constructorfleet/SketchForge-3D/issues/412) — P2, implementation and regression coverage in progress.
- [#436: Preserve mirrors in REST face and prism drafts](https://github.com/constructorfleet/SketchForge-3D/issues/436) — implementation and regression coverage complete; awaiting merge.
