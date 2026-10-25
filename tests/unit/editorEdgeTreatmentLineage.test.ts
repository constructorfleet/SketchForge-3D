import { describe, expect, it } from "vitest";
import type { OcctKernel, Vec3 } from "occt-wasm";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { shapeEdges } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { sketchSourceEdgesForEdgeIndexes } from "@constructorfleet/sketchforge-engine/sketchEdgeSegmentLineage";
import { cadBrepTransformForShape } from "@/lib/engine/cadBakeMetadata";
import { resizedSketchExtrusionProfile } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { cadSketchRegions } from "@constructorfleet/sketchforge-engine/sketchCadProfile";
import { boundaryEdgeOnKernel } from "@/lib/engine/sketchEdgeSegmentLineageKernel";
import { reconstructParts } from "@/lib/cadModifierParts";
import { sessionEdgeIdsForSourceEdgesOnKernel, sessionSourceEdgesOnKernel } from "@/lib/cadModifierEdgeLineage";
import {
  edgeTreatmentFeatureWithLineage,
  edgeTreatmentLineageTarget,
  isRigidCadTransform,
  selectedEdgeTreatmentReplay,
} from "@/lib/edgeTreatmentLineage";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// #540: the editor's fillet/chamfer tool numbers edges on the CAD worker's own
// placed and healed copy of the solid. It now names a selected cap edge by the
// same sketch segment and cap the REST path records (#350), through the
// engine's matcher, and finds those edges again on a rebuilt extrusion.

const HEIGHT = 3;

/** A rectangle 2 wide in X whose `ab` side sits at z = `abZ`; `cd` stays at z = 1. */
function rectangle(abZ = -1): SketchProfile {
  return {
    points: [
      { id: "a", x: -1, z: abZ }, { id: "b", x: 1, z: abZ },
      { id: "c", x: 1, z: 1 }, { id: "d", x: -1, z: 1 },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
  };
}

const PLACEMENT = { x: 4, z: -2, elevation: 1, rotation: 30 };

function extrusion(abZ = -1, extra: Record<string, unknown> = {}) {
  return sketchExtrusionShapeFromRequest({ id: "editor-lineage", profile: rectangle(abZ), height: HEIGHT, ...PLACEMENT, ...extra });
}

/** A raw-frame point placed the way the worker places the stored B-rep. */
function placed(point: Vec3, transform: number[] | undefined): Vec3 {
  if (!transform) return point;
  return {
    x: transform[0]! * point.x + transform[1]! * point.y + transform[2]! * point.z + transform[3]!,
    y: transform[4]! * point.x + transform[5]! * point.y + transform[6]! * point.z + transform[7]!,
    z: transform[8]! * point.x + transform[9]! * point.y + transform[10]! * point.z + transform[11]!,
  };
}

/**
 * The worker's session for one stored-B-rep part, built by the worker's own
 * `reconstructParts` from the part the editor sends it (the B-rep and
 * `cadBrepTransformForShape`), edges numbered as `collectEdges` numbers them.
 */
function workerSession(cad: OcctKernel, shape: WorkplaneShape) {
  const transform = cadBrepTransformForShape(shape);
  const solid = reconstructParts(cad, [{ brep: shape.cadBrep!, brepTransform: transform, hole: false }]);
  const handles = cad.getSubShapes(solid, "edge");
  return { transform, solid, handles, edges: handles.map((edge) => boundaryEdgeOnKernel(cad, edge)) };
}

/** The editor's `cleanModelDimension`: dimensions are kept to the micrometre. */
const cleanModelDimension = (value: number) => Math.max(0.01, Number(value.toFixed(3)));

/**
 * A sketch extrusion as the editor builds it, not as the REST path does: the
 * sketch worker's straight-edge wire, extruded, then recorded the way
 * `shapeFromCadMesh` records it, with dimensions rounded by
 * `cleanModelDimension` while the mesh keeps its raw base size.
 */
function editorBuiltExtrusion(cad: OcctKernel, profile: SketchProfile, placement: { x: number; z: number; elevation: number; rotation: number }): WorkplaneShape {
  const [region] = cadSketchRegions(profile);
  const wire = cad.makeWire(region!.outer.steps.map(({ from, to }) => cad.makeLineEdge({ x: from.x, y: 0, z: from.z }, { x: to.x, y: 0, z: to.z })));
  const solid = cad.extrude(cad.makeFace(wire), 0, HEIGHT, 0);
  const { positions } = cad.tessellate(solid, { linearDeflection: 0.05, angularDeflection: 0.16 });
  const axis = (offset: number) => Array.from(positions).filter((_, index) => index % 3 === offset);
  const [xs, ys, zs] = [axis(0), axis(1), axis(2)];
  const raw = { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), depth: Math.max(...zs) - Math.min(...zs) };
  const [width, height, depth] = [cleanModelDimension(raw.width), cleanModelDimension(raw.height), cleanModelDimension(raw.depth)];
  return {
    id: "editor-built", name: "Sketch extrusion", kind: "mesh", color: "#d41721",
    ...placement, size: Math.max(width, depth), width, depth, height,
    sketchProfile: profile, sketchOperation: "extrude", sketchSourceId: "sketch-editor-built",
    importedMesh: { positions: [], baseWidth: raw.width, baseDepth: raw.depth, baseHeight: raw.height, triangleCount: 0, sourceFormat: "json" },
    cadBrep: cad.toBREP(solid),
    cadBrepFrame: {
      x: (Math.max(...xs) + Math.min(...xs)) / 2, z: (Math.max(...zs) + Math.min(...zs)) / 2, elevation: Math.min(...ys), width, depth, height,
    },
  };
}

/** The session id of the straight edge whose placed endpoints are these raw-frame points. */
function sessionIdAt(session: ReturnType<typeof workerSession>, from: Vec3, to: Vec3) {
  const [a, b] = [placed(from, session.transform), placed(to, session.transform)];
  const near = (p: Vec3, q: Vec3) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < 1e-6;
  const ids = session.edges.flatMap((edge, id) => edge.vertices.length === 2
    && ((near(edge.vertices[0]!, a) && near(edge.vertices[1]!, b)) || (near(edge.vertices[0]!, b) && near(edge.vertices[1]!, a))) ? [id] : []);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

/** The engine's listed index of the line edge running along X at (z, y), as `GET /edges` would find it. */
async function engineEdgeIndexAt(shape: WorkplaneShape, z: number, y: number) {
  const edges = (await shapeEdges(shape)).filter((edge) => edge.curveType === "line"
    && Math.abs(edge.midpoint.x) < 1e-6 && Math.abs(edge.midpoint.z - z) < 1e-6 && Math.abs(edge.midpoint.y - y) < 1e-6);
  expect(edges).toHaveLength(1);
  return edges[0]!.index;
}

/**
 * A 2 x HEIGHT x depth box in the raw frame with its two top X-running edges
 * rounded by `r`. Each removes r^2 (1 - pi/4) along its length 2, centred
 * r (10 - 3pi) / (12 - 3pi) in from both the top and its own side face.
 */
function topFilletedBox(abZ: number, r: number) {
  const depth = 1 - abZ;
  const box = 2 * depth * HEIGHT;
  const removedEach = 2 * r * r * (1 - Math.PI / 4);
  const offset = (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);
  const volume = box - 2 * removedEach;
  const y = (box * HEIGHT / 2 - 2 * removedEach * (HEIGHT - offset)) / volume;
  // Symmetric in z: one rounded edge on each side, at the same offset in.
  return { volume, center: { x: 0, y, z: (abZ + 1) / 2 } };
}

describe("editor fillet and chamfer record sketch-segment lineage", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("names the worker's selected cap edges exactly as the REST path names the same edges", async () => {
    const shape = await extrusion();
    const engineIndexes = [await engineEdgeIndexAt(shape, -1, HEIGHT), await engineEdgeIndexAt(shape, 1, HEIGHT)];
    const engine = await sketchSourceEdgesForEdgeIndexes(shape, engineIndexes);
    expect(engine).toEqual({ status: "matched", sourceEdges: [{ segmentId: "ab", cap: "top" }, { segmentId: "cd", cap: "top" }] });

    const editor = await withCadKernel((cad) => {
      const session = workerSession(cad, shape);
      const ids = [
        sessionIdAt(session, { x: -1, y: HEIGHT, z: -1 }, { x: 1, y: HEIGHT, z: -1 }),
        sessionIdAt(session, { x: 1, y: HEIGHT, z: 1 }, { x: -1, y: HEIGHT, z: 1 }),
      ];
      return sessionSourceEdgesOnKernel(cad, shape, session.transform, ids.map((id) => session.edges[id]!));
    });
    expect(editor).toEqual(engine);
  });

  it("names the cap edges of an editor-built extrusion with awkward dimensions, placed with rotation", async () => {
    // Off-grid corners: the editor rounds the shape's dimensions to the
    // micrometre while its mesh keeps the raw ones, which the server's resize
    // test (#539) reads as a resize of a few parts in a hundred thousand.
    // Scaling the profile by that would move its endpoints past the matcher's
    // tolerance, so the editor matches the stored B-rep as stored.
    const awkward: SketchProfile = {
      points: [
        { id: "a", x: -1.23456789, z: -0.98765432 }, { id: "b", x: 2.34567891, z: -0.98765432 },
        { id: "c", x: 2.34567891, z: 1.11111111 }, { id: "d", x: -1.23456789, z: 1.11111111 },
      ],
      segments: rectangle().segments,
    };
    const result = await withCadKernel((cad) => {
      const shape = editorBuiltExtrusion(cad, awkward, { x: -3, z: 7, elevation: 2, rotation: 30 });
      const target = edgeTreatmentLineageTarget(shape, [shape]);
      const session = workerSession(cad, shape);
      const ids = [
        sessionIdAt(session, { x: -1.23456789, y: HEIGHT, z: -0.98765432 }, { x: 2.34567891, y: HEIGHT, z: -0.98765432 }),
        sessionIdAt(session, { x: 2.34567891, y: HEIGHT, z: 1.11111111 }, { x: -1.23456789, y: HEIGHT, z: 1.11111111 }),
      ];
      return {
        targeted: target !== null,
        looksResizedToServer: resizedSketchExtrusionProfile(shape) !== null,
        named: sessionSourceEdgesOnKernel(cad, target!.source, target!.brepTransform, ids.map((id) => session.edges[id]!)),
      };
    });
    expect(result).toEqual({
      targeted: true,
      looksResizedToServer: true,
      named: { status: "matched", sourceEdges: [{ segmentId: "ab", cap: "top" }, { segmentId: "cd", cap: "top" }] },
    });
  });

  it("names a bottom cap edge by its cap", async () => {
    const shape = await extrusion();
    const result = await withCadKernel((cad) => {
      const session = workerSession(cad, shape);
      const id = sessionIdAt(session, { x: 1, y: 0, z: -1 }, { x: 1, y: 0, z: 1 });
      return sessionSourceEdgesOnKernel(cad, shape, session.transform, [session.edges[id]!]);
    });
    expect(result).toEqual({ status: "matched", sourceEdges: [{ segmentId: "bc", cap: "bottom" }] });
  });

  it("records nothing for a side edge, a mirrored shape or a shape already treated", async () => {
    const shape = await extrusion();
    const results = await withCadKernel((cad) => {
      const session = workerSession(cad, shape);
      const top = session.edges[sessionIdAt(session, { x: -1, y: HEIGHT, z: -1 }, { x: 1, y: HEIGHT, z: -1 })]!;
      const side = session.edges[sessionIdAt(session, { x: 1, y: 0, z: -1 }, { x: 1, y: HEIGHT, z: -1 })]!;
      return {
        side: sessionSourceEdgesOnKernel(cad, shape, session.transform, [top, side]).status,
        mirrored: sessionSourceEdgesOnKernel(cad, { ...shape, mirrorX: true }, session.transform, [top]).status,
        treated: sessionSourceEdgesOnKernel(cad, {
          ...shape,
          edgeTreatments: [{ kind: "fillet", amount: 0.1, edgeCount: 1 }],
        }, session.transform, [top]).status,
        // The worker placed elsewhere than the stored B-rep says: no edge is the same edge.
        misplaced: sessionSourceEdgesOnKernel(cad, shape, undefined, [top]).status,
      };
    });
    expect(results).toEqual({ side: "missing", mirrored: "unsupported", treated: "unsupported", misplaced: "missing" });
  });

  it("finds the recorded edges on the rebuilt extrusion and rounds the right ones, by volume and centre of mass", async () => {
    const r = 0.25;
    const sourceEdges = [{ segmentId: "ab", cap: "top" as const }, { segmentId: "cd", cap: "top" as const }];
    const edited = await extrusion(-2);
    const result = await withCadKernel((cad) => {
      const session = workerSession(cad, edited);
      const found = sessionEdgeIdsForSourceEdgesOnKernel(cad, edited, session.transform, session.edges, sourceEdges);
      if (found.status !== "matched") return { found };
      const filleted = cad.fillet(session.solid, found.edgeIds.map((id) => session.handles[id]!), r);
      const { volume, centerOfMass } = cad.queryBatch([filleted])[0]!;
      return { found, volume, centerOfMass };
    });
    expect(result.found.status).toBe("matched");
    const expected = topFilletedBox(-2, r);
    const transform = cadBrepTransformForShape(edited);
    const centre = placed(expected.center, transform);
    expect(result.volume).toBeCloseTo(expected.volume, 6);
    expect(result.centerOfMass!.x).toBeCloseTo(centre.x, 5);
    expect(result.centerOfMass!.y).toBeCloseTo(centre.y, 5);
    expect(result.centerOfMass!.z).toBeCloseTo(centre.z, 5);
  });

  it("says which recorded edge a sketch edit removed", async () => {
    const triangle: SketchProfile = {
      points: [{ id: "a", x: -1, z: -1 }, { id: "b", x: 1, z: -1 }, { id: "c", x: 0, z: 1 }],
      segments: [
        { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" }, { id: "ca", startId: "c", endId: "a" },
      ],
    };
    const edited = await sketchExtrusionShapeFromRequest({ id: "editor-lineage", profile: triangle, height: HEIGHT, ...PLACEMENT });
    const result = await withCadKernel((cad) => {
      const session = workerSession(cad, edited);
      return sessionEdgeIdsForSourceEdgesOnKernel(cad, edited, session.transform, session.edges, [
        { segmentId: "ab", cap: "top" }, { segmentId: "cd", cap: "top" },
      ]);
    });
    expect(result).toEqual({ status: "missing", sourceEdge: { segmentId: "cd", cap: "top" } });
  });
});

describe("which editor treatments carry lineage, and which sketch edits replay it", () => {
  const feature = { kind: "fillet" as const, amount: 0.25, edgeCount: 2 };
  const sourceEdges = [{ segmentId: "ab", cap: "top" as const }, { segmentId: "cd", cap: "top" as const }];

  it("asks for lineage only for one bare, rigidly placed sketch extrusion", async () => {
    const shape = await extrusion();
    const target = edgeTreatmentLineageTarget(shape, [shape]);
    expect(target?.brepTransform).toEqual(cadBrepTransformForShape(shape));
    expect(target?.source.cadBrep).toBe(shape.cadBrep);
    expect(edgeTreatmentLineageTarget({ ...shape, groupedShapes: [shape] }, [shape])).toBeNull();
    expect(edgeTreatmentLineageTarget(shape, [shape, { ...shape, id: "other" }])).toBeNull();
    expect(edgeTreatmentLineageTarget({ ...shape, mirrorZ: true }, [{ ...shape, mirrorZ: true }])).toBeNull();
    // Resized since it was built: the worker's edges are scaled, the sketch is not.
    const stretched = { ...shape, width: shape.width * 1.5 };
    expect(edgeTreatmentLineageTarget(stretched, [stretched])).toBeNull();
    const treated = { ...shape, edgeTreatments: [feature] };
    expect(edgeTreatmentLineageTarget(treated, [treated])).toBeNull();
    const revolve = { ...shape, sketchOperation: "revolve" as const };
    expect(edgeTreatmentLineageTarget(revolve, [revolve])).toBeNull();
  });

  it("tells a rigid placement from a scaled or reflected one", () => {
    const turn = (degrees: number) => {
      const r = degrees * Math.PI / 180;
      return [Math.cos(r), 0, Math.sin(r), 4, 0, 1, 0, 1, -Math.sin(r), 0, Math.cos(r), -2];
    };
    expect(isRigidCadTransform(turn(30))).toBe(true);
    expect(isRigidCadTransform([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])).toBe(false);
    expect(isRigidCadTransform([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])).toBe(false);
  });

  it("records lineage only for every selected edge of a selected-edge treatment", () => {
    expect(edgeTreatmentFeatureWithLineage(feature, sourceEdges)).toEqual({ ...feature, sourceEdges });
    expect(edgeTreatmentFeatureWithLineage(feature, null)).toEqual(feature);
    expect(edgeTreatmentFeatureWithLineage(feature, sourceEdges.slice(0, 1))).toEqual(feature);
    expect(edgeTreatmentFeatureWithLineage({ ...feature, allEdges: true }, sourceEdges)).toEqual({ ...feature, allEdges: true });
  });

  it("replays one recorded treatment, leaves an unrecorded one as before and refuses one it cannot replay", async () => {
    const shape = await extrusion();
    const recorded = { ...feature, sourceEdges };
    const entry = { id: "edge-history-1", createdAt: 1, feature: recorded, before: shape };
    const kept = { ...shape, edgeTreatments: [recorded], edgeTreatmentHistory: [entry] };
    expect(selectedEdgeTreatmentReplay(shape)).toEqual({ status: "none" });
    expect(selectedEdgeTreatmentReplay({ ...shape, edgeTreatments: [feature], edgeTreatmentHistory: [{ ...entry, feature }] }))
      .toEqual({ status: "none" });
    expect(selectedEdgeTreatmentReplay(kept)).toEqual({ status: "replay", feature: recorded, entry });
    expect(selectedEdgeTreatmentReplay({ ...kept, edgeTreatments: [recorded, feature] }).status).toBe("blocked");
    expect(selectedEdgeTreatmentReplay({ ...kept, edgeTreatmentHistory: [{ ...entry, feature: { ...recorded, amount: 0.5 } }] }).status).toBe("blocked");
    expect(selectedEdgeTreatmentReplay({ ...kept, draftPrismAngle: 5 }).status).toBe("blocked");
  });
});
