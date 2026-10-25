---
slug: "/docs/PERFORMANCE"
title: "Kernel performance budgets"
audience: "Contributors and API operators"
owner: "Engine"
sources:
  - "tests/perf/kernel-operations.perf.ts"
  - "tests/perf/support/kernelBudget.ts"
  - ".github/workflows/perf.yml"
---

# Kernel performance budgets

Run `npm run engine:build && npm run perf` to execute the import/persistence and exact-kernel performance lanes. The kernel benchmarks print one JSON row per operation with `wallMs`, `heapDeltaMb`, and its enforced budget. The Performance workflow runs on pushes to `main`, weekly, and on manual dispatch; its `performance-report-<run id>` artifact contains the complete output even when a test fails.

The following are regression ceilings with headroom for shared CI runners, not interactive response-time promises. Each operation runs once against a warmed kernel. Fixture generation, initial STEP import, and result validation are outside the timed interval. Operation time includes kernel work, serialization/tessellation performed by the operation, and session cleanup. Tests execute sequentially within this suite; the other performance suites may run concurrently.

| Workload | Wall-time ceiling | JS heap-delta ceiling | Correctness check |
| --- | ---: | ---: | --- |
| Cut 20 overlapping boxes with one cutter | 30 seconds | 128 MiB | Remaining exact volume is 61 mm³ |
| Explode a 200-solid STEP document below the 8 MiB cap | 60 seconds | 256 MiB | 200 parts retain exact STEP geometry |
| Interference among 128 shapes, arranged into 64 penetrating pairs | 30 seconds | 128 MiB | 64 pairs, each with 4 mm³ overlap |
| Section a closed mesh with 240,000 actual triangles | 10 seconds | 512 MiB | One SVG section loop enclosing 100 mm² centred on the origin |
| All-edge fillet of a revolve with 24 display sides | 15 seconds | 128 MiB | Exact volume matches the analytical rounded annular section |

The interference workload exercises the shape-count limit and real narrow-phase intersections; it does not saturate the separate 512-candidate cap. The section fixture is a subdivided cube. Meshes are sliced directly rather than sewn into an OCCT solid, so this measures the linear slicer and the mesh placement before it, at well above the 50,000 triangles the sewn path used to be capped at; it does not claim to represent every topology of that size. The revolve uses current exact topology, rather than forcing the old tessellated fallback.

Heap delta is `process.memoryUsage().heapUsed` after minus before the operation. It measures retained JavaScript heap at those two instants, not peak process memory or WebAssembly linear memory. Garbage collection can make it negative. The ceilings allow this variability; a dedicated memory profiler is needed to diagnose kernel allocations.

If a ceiling fails, inspect its row and the workload result before changing the budget. Keep workload sizes and correctness assertions intact, and record measured timings when proposing a new ceiling.
