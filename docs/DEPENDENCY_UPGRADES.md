---
slug: /docs/DEPENDENCY_UPGRADES
title: Major dependency upgrade spikes
audience: Contributors
owner: Contributors
---

# Major dependency upgrade spikes

The package registry survey below was run on 2026-10-24 with `npm view <package> version`. It confirms the candidate release numbers from [issue #398](https://github.com/constructorfleet/SketchForge-3D/issues/398); it does not establish compatibility. No candidate major has been installed or validated by this survey. Each isolated spike must record the exact build and test results in its issue before an upgrade is proposed for merge.

| Package | Current range in the repository | Candidate | Spike | Required focus |
| --- | --- | --- | --- | --- |
| Next | `^15.5.28` | `16.4.3` | [#460](https://github.com/constructorfleet/SketchForge-3D/issues/460) | Typecheck, unit, build, browser tests, desktop build |
| Electron | `^43.8.1` | `45.0.0` | [#461](https://github.com/constructorfleet/SketchForge-3D/issues/461) | Desktop packaging and release workflow compatibility |
| Vitest | `^4.1.12` | `5.0.5` | [#462](https://github.com/constructorfleet/SketchForge-3D/issues/462) | Unit, e2e, integration, browser, and performance suites |
| TypeScript | `^5.8.3` (root and packages) | `7.0.2` | [#463](https://github.com/constructorfleet/SketchForge-3D/issues/463) | All package typechecks and builds |
| occt-wasm | `^3.6.1` | `5.8.0` | [#464](https://github.com/constructorfleet/SketchForge-3D/issues/464) | Engine build, STEP round-trip e2e, engine performance |
| brepjs | `^18.118.0` | `20.10.3` | [#465](https://github.com/constructorfleet/SketchForge-3D/issues/465) | Engine build, STEP round-trip e2e, engine performance |
| three | `^0.184.0` | `0.186.1` | [#466](https://github.com/constructorfleet/SketchForge-3D/issues/466) | Editor rendering, transforms, import/export |
| mermaid | `^11.17.2` | `12.2.0` | [#467](https://github.com/constructorfleet/SketchForge-3D/issues/467) | VitePress plugin, docs build, diagram rendering |
| js-yaml | `^4.3.2` | `5.5.0` | [#468](https://github.com/constructorfleet/SketchForge-3D/issues/468) | Node support, parser compatibility, YAML consumers |

## Suggested sequencing

Start Electron before the next desktop release, then evaluate Next and test tooling. Evaluate the CAD kernel packages last and independently: their spikes must pass STEP round-trip browser/e2e coverage and the engine performance lane before adoption. Keep `occt-wasm` and `brepjs` separate so a failure can be attributed to one package. The order remains a maintainer decision; this page does not authorize or imply a production dependency upgrade.

## Verification record

At plan creation, all nine spikes are open and awaiting isolated build/test results. The registry survey is the only completed check. Do not report the package upgrades as tested or green until the linked spike records actual results.
