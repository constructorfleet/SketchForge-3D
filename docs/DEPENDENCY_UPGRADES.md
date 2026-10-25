---
slug: /docs/DEPENDENCY_UPGRADES
title: Major dependency upgrade spikes
audience: Contributors
owner: Contributors
---

# Major dependency upgrade spikes

The 2026-10-24 package survey identified the candidate versions for issues [#460–#468](https://github.com/constructorfleet/SketchForge-3D/issues/460). The original PR #472 merged Electron 45 and js-yaml 5 only. The 2026-10-25 follow-up branch upgrades the remaining packages together; its verification record is in [the combined dependency report](./dependency-spikes/460-468.md).

| Package | Current range in the repository | Candidate | Spike | Required focus |
| --- | --- | --- | --- | --- |
| Next | `^15.5.28` | `16.4.3` | [#460](https://github.com/constructorfleet/SketchForge-3D/issues/460) | Typecheck, unit, build, browser tests, desktop build |
| Electron | `^43.8.1` | `45.0.0` | [#461](https://github.com/constructorfleet/SketchForge-3D/issues/461) | macOS arm64 directory package built; Electron framework in the artifact reports `45.0.0`. Cross-platform release packaging remains unverified. |
| Vitest | `^4.1.12` | `5.0.5` | [#462](https://github.com/constructorfleet/SketchForge-3D/issues/462) | Unit, e2e, integration, browser, and performance suites |
| TypeScript | `^5.8.3` (root and packages) | `7.0.2` | [#463](https://github.com/constructorfleet/SketchForge-3D/issues/463) | All package typechecks and builds |
| occt-wasm | `^3.6.1` | `5.8.0` | [#464](https://github.com/constructorfleet/SketchForge-3D/issues/464) | Engine build, STEP round-trip e2e, engine performance |
| brepjs | `^18.118.0` | `20.10.3` | [#465](https://github.com/constructorfleet/SketchForge-3D/issues/465) | Engine build, STEP round-trip e2e, engine performance |
| three | `^0.184.0` | `0.186.1` | [#466](https://github.com/constructorfleet/SketchForge-3D/issues/466) | Editor rendering, transforms, import/export |
| mermaid | `^11.17.2` | `12.2.0` | [#467](https://github.com/constructorfleet/SketchForge-3D/issues/467) | VitePress plugin, docs build, diagram rendering |
| js-yaml | `^4.3.2` | `5.5.0` | [#468](https://github.com/constructorfleet/SketchForge-3D/issues/468) | Node support, parser compatibility, YAML consumers |

## Verification record

The Electron spike built the web bundle and a macOS arm64 directory package with Electron 45.0.0. macOS code signing was skipped because no valid Developer ID identity was available; other platform packaging remains unverified. The follow-up's unit suite and typechecks pass. Grouped STEP face colors still need to pass under OCCT 5.8; see the combined report for the current result and remaining gates.
