/**
 * Measuring real geometry on the server, from the exact B-rep.
 *
 * What a CAD user wants to measure is the model, not a picture of it: the length
 * of an edge, the distance between two faces, the diameter of a bore. Every
 * number here comes from OCCT's own curve and surface analysis -- `curveLength`,
 * `curveParameters`, `getFaceCylinderData`, `getSurfaceArea`, `distanceBetween`
 * -- and none of it from a tessellation.
 *
 * That is not a purity argument. A triangulated cylinder has no radius at all,
 * only facets, so a measurement read off the mesh would be out by the chord
 * error of whatever quality setting happened to be in force -- and it would be
 * wrong in exactly the cases somebody reaches for a measuring tool. #57 found
 * this app had been building spheres as revolved splines that measured 0.0427%
 * off their true volume, which is the same class of quiet error one step
 * further back.
 *
 * The listing numbers entities as `GET /edges` and `GET /faces` number them, and
 * for the same reason: edges come from `edgeSolidForShape`, which the edge
 * listing and a fillet also use, and faces from `orientedSolidForShape`, which
 * the face listing uses, so an index means one thing across the listing, the
 * measurement and the fillet that follows. A *distance* is the one measurement that also depends on
 * where the shape sits, and `measureBetween` says below what it does instead.
 *
 * A measurement that is not meaningful for the entity selected is reported as
 * `null` with a reason rather than guessed at. The derivations themselves live
 * in `lib/cadMeasurements.ts`, which has no kernel in it and is tested against
 * closed forms.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import {
  circularEdgeRadius,
  faceRadius,
  planarFaceAngle,
  type AngleUnavailableCode,
  type RadiusUnavailableCode,
} from "./cadMeasurements.js";
import { withCadKernel } from "./serverCadKernel.js";
import { edgeSolidForShape, orientedSolidForShape, ServerCadError, treatmentBakesRotation } from "./serverCadOperations.js";
import { faceOutwardNormal } from "./serverCadShell.js";
import { placedSolidForShape } from "./serverShapeBooleans.js";
import { shapePlacementMatrix } from "./serverShapeGroups.js";
import type { WorkplaneShape } from "./domain/sketchforge.js";

export type MeasurementEntityKind = "edge" | "face";

export type ServerCadMeasurement = {
  entity: MeasurementEntityKind;
  /** The same index `GET /edges` and `GET /faces` give this entity. */
  index: number;
  /** As OCCT names it: `line`, `circle`, `bspline` for an edge; `plane`, `cylinder` for a face. */
  geometryType: string;
  /** Edge length in mm, arcs measured along the curve. Null for a face. */
  length: number | null;
  /** Face area in mm^2. Null for an edge. */
  area: number | null;
  radius: number | null;
  diameter: number | null;
  /** Degrees a circular edge runs through; a full circle is 360. Null otherwise. */
  sweepDegrees: number | null;
  /** Why there is no radius. Null when one is reported. */
  radiusUnavailable: RadiusUnavailableCode | null;
};

function edgeMeasurement(cad: OcctKernel, handle: ShapeHandle, index: number): ServerCadMeasurement {
  let geometryType = "unknown";
  try {
    geometryType = cad.curveType(handle);
  } catch {
    // Not every edge reports a curve type; its length still means something.
  }
  const length = cad.curveLength(handle);
  const range = cad.curveParameters(handle);
  const measured = circularEdgeRadius({
    curveKind: geometryType,
    length,
    first: range.first,
    last: range.last,
    closed: cad.curveIsClosed(handle),
  });
  return {
    entity: "edge",
    index,
    geometryType,
    length,
    area: null,
    radius: measured.available ? measured.radius : null,
    diameter: measured.available ? measured.diameter : null,
    sweepDegrees: measured.available ? (measured.sweepRadians * 180) / Math.PI : null,
    radiusUnavailable: measured.available ? null : measured.code,
  };
}

/** The radius the kernel's own cylinder accessor reports, or null for any other surface. */
function cylinderRadiusOf(cad: OcctKernel, face: ShapeHandle) {
  try {
    return cad.getFaceCylinderData(face)?.radius ?? null;
  } catch {
    return null;
  }
}

/** The surface kind, or `unknown` -- which every measurement that needs a kind refuses. */
function surfaceKindOf(cad: OcctKernel, face: ShapeHandle) {
  try {
    return cad.surfaceType(face);
  } catch {
    // Not every surface reports a type; a face's area still does.
    return "unknown";
  }
}

function faceMeasurement(cad: OcctKernel, handle: ShapeHandle, index: number): ServerCadMeasurement {
  const geometryType = surfaceKindOf(cad, handle);
  const measured = faceRadius(geometryType, cylinderRadiusOf(cad, handle));
  return {
    entity: "face",
    index,
    geometryType,
    length: null,
    area: cad.getSurfaceArea(handle),
    radius: measured.available ? measured.radius : null,
    diameter: measured.available ? measured.diameter : null,
    sweepDegrees: null,
    radiusUnavailable: measured.available ? null : measured.code,
  };
}

/** Every edge and face of a shape, measured. */
export function shapeMeasurements(shape: WorkplaneShape): Promise<ServerCadMeasurement[]> {
  return withCadKernel((cad) => {
    // Edges from the solid `GET /edges` numbers, faces from the one `GET /faces`
    // numbers. They differ only for an untreated revolve, whose edges are its
    // exact circles while its default face listing is still its mesh's. A
    // revolve the edge listing refuses (a partial turn, a thread) is still
    // measured, from its mesh, as it was before the listing refused it.
    const faceSolid = orientedSolidForShape(cad, shape);
    let edgeSolid = faceSolid;
    try {
      edgeSolid = edgeSolidForShape(cad, shape);
    } catch (error) {
      if (!(error instanceof ServerCadError)) throw error;
    }
    return [
      ...cad.getSubShapes(edgeSolid, "edge").map((handle, index) => edgeMeasurement(cad, handle, index)),
      ...cad.getSubShapes(faceSolid, "face").map((handle, index) => faceMeasurement(cad, handle, index)),
    ];
  });
}

/**
 * One end of a between-entities measurement.
 *
 * `shape` measures the whole solid, which is what "how far apart are these two
 * parts" means; an `index` narrows it to one edge or face of that solid.
 */
export type MeasurementTarget = {
  shape: WorkplaneShape;
  entity: MeasurementEntityKind | "shape";
  index?: number;
};

/**
 * The same end, naming its shape by id rather than carrying it.
 *
 * This is what a request can express; the engine resolves the ids against the
 * project, so a shape that is not in it is a `shapes_not_found` naming which --
 * the same answer every other operation gives -- rather than a kernel failure.
 */
export type MeasurementEndRef = {
  shapeId: string;
  entity: MeasurementEntityKind | "shape";
  index?: number;
};

export type ServerCadMeasurementPair = {
  /** Exact minimum distance between the two entities, in mm. Zero when they touch. */
  distance: number;
  /** Angle between two planar faces' outward normals, in degrees. Null otherwise. */
  angleDegrees: number | null;
  /** Why there is no angle. Null when one is reported. */
  angleUnavailable: AngleUnavailableCode | null;
};

function resolveTarget(cad: OcctKernel, target: MeasurementTarget, label: string) {
  // Placed, not local. A distance is the one measurement that depends on where
  // the shapes are, and `orientedSolidForShape` -- which the edge and face
  // listings use, and which is right for them -- hands back the solid in its own
  // frame with the rotation applied and the translation not. Two parts 60mm
  // apart both measured from the origin through that, so this read zero.
  // Edges have their own canonical solid: for an untreated plain revolve it
  // is rebuilt from the retained profile, exactly like GET /edges and edge
  // treatments. The stored mesh has many more edges and cannot resolve those
  // listed indexes. Faces continue to use their existing placed solid.
  let solid: ShapeHandle;
  if (target.entity === "edge") {
    solid = edgeSolidForShape(cad, target.shape);
    // The edge listing and treatment solid is in the shape frame: its mirror
    // is already applied, while a treatment may bake a parametric shape's
    // rotation into the geometry. Put that same solid where it sits without
    // applying either transform twice. Untreated revolves are the exception:
    // their exact edge solid is rebuilt from the profile before rotation.
    const rotationAlreadyApplied = treatmentBakesRotation(target.shape)
      && target.shape.sketchOperation !== "revolve";
    const placementShape = {
      ...target.shape,
      mirrorX: undefined,
      mirrorY: undefined,
      mirrorZ: undefined,
      ...(rotationAlreadyApplied ? { rotation: 0, rotationX: 0, rotationZ: 0 } : {}),
    };
    const elements = shapePlacementMatrix(placementShape).elements;
    solid = cad.transform(solid, [
      elements[0], elements[4], elements[8], elements[12],
      elements[1], elements[5], elements[9], elements[13],
      elements[2], elements[6], elements[10], elements[14],
    ]);
  } else {
    solid = placedSolidForShape(cad, target.shape);
  }
  if (target.entity === "shape") {
    return { handle: solid, face: null };
  }
  const subShapes = cad.getSubShapes(solid, target.entity);
  const index = target.index ?? 0;
  const handle = subShapes[index];
  if (!handle) {
    const plural = subShapes.length === 1 ? target.entity : `${target.entity}s`;
    throw new ServerCadError(
      `${label}: that shape has ${subShapes.length} ${plural}, so there is no ${target.entity} ${index}.`,
      422,
    );
  }
  return { handle, face: target.entity === "face" ? handle : null };
}

/**
 * The distance between two entities, and the angle if both are flat faces.
 *
 * `distanceBetween` is OCCT's own minimum-distance solver, so it answers for any
 * pairing -- edge to face, face to solid, solid to solid -- and it measures the
 * real surfaces rather than their corners. Two cylinders 5mm apart at their
 * nearest walls read 5, which a bounding-box subtraction would not.
 *
 * Both solids are built inside one `withCadKernel` call because the kernel
 * releases every handle when that call returns.
 */
export function measureBetween(from: MeasurementTarget, to: MeasurementTarget): Promise<ServerCadMeasurementPair> {
  return withCadKernel((cad) => {
    const a = resolveTarget(cad, from, "from");
    const b = resolveTarget(cad, to, "to");
    const distance = cad.distanceBetween(a.handle, b.handle);

    if (!a.face || !b.face) {
      return { distance, angleDegrees: null, angleUnavailable: "notPlanar" as const };
    }
    const normalA = faceOutwardNormal(cad, a.face);
    const normalB = faceOutwardNormal(cad, b.face);
    if (!normalA || !normalB) {
      return { distance, angleDegrees: null, angleUnavailable: "degenerateNormal" as const };
    }
    const angle = planarFaceAngle(
      { surfaceKind: surfaceKindOf(cad, a.face), normal: normalA },
      { surfaceKind: surfaceKindOf(cad, b.face), normal: normalB },
    );
    return {
      distance,
      angleDegrees: angle.available ? angle.angleDegrees : null,
      angleUnavailable: angle.available ? null : angle.code,
    };
  });
}
