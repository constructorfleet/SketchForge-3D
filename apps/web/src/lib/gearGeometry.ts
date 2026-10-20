/**
 * The gear, both halves.
 *
 * This file used to hold the normalizers and the mesh builder together, so
 * anything wanting the first took `three` with it. The maths now lives in
 * `gearProfile` (no `three`) and the builder in `gearMesh`; this is the barrel
 * the editor imports, so no call site had to move. Kernel-side callers should
 * import `@/lib/engine/gearProfile` directly.
 */

export * from "@/lib/engine/gearProfile";
export * from "@/lib/gearMesh";
