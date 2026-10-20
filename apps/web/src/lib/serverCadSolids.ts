/**
 * Exact solids for stored shapes, server side (upstream issue #55).
 *
 * Node-only. The editor can hand OCCT any shape because it can mesh any shape
 * in the browser; the server has no mesher, so it builds the geometry itself
 * from what the project stores. Every shape here is built as true geometry --
 * a round cylinder is a cylinder, not a 96-sided prism -- so a fillet lands on
 * real surfaces rather than on a tessellation of them.
 *
 * The profile maths is shared with the STEP exporter (`stepProfiles`), which
 * had to answer exactly the same questions about facets, taper, and yaw.
 */

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import {
  DEFAULT_LOFT_BOTTOM_SHAPE,
  DEFAULT_LOFT_TOP_SHAPE,
  isPolygonLoftShape,
  normalizeLoftShape,
  normalizeLoftTopSize,
} from "@/lib/loftGeometry";
import {
  isFacetedCylinder,
  planTaper,
  polygonRing,
  rectangleRing,
  type ProfilePoint,
} from "@/lib/stepProfiles";
import { regularPolygonFootprintScale } from "@/lib/regularPolygonFootprint";
import { shapeDepth, shapeHasTaper, shapeWidth } from "@/lib/workplaneShapes";
import type { LoftProfileShape, WorkplaneShape } from "@/types/sketchforge";

const CIRCULAR_EPSILON = 0.0005;
const Y_AXIS = { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
const X_AXIS = { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } };

/** Why a shape cannot be built exactly, for the caller to report as-is. */
export class UnbuildableShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbuildableShapeError";
  }
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

/**
 * The single solid inside a boolean's result.
 *
 * Cut and fuse hand back a compound wrapping the result, and OCCT refuses a
 * compound wherever it wants a solid -- including as the input to a fillet.
 */
function solidOf(cad: OcctKernel, shape: ShapeHandle) {
  if (cad.isSolid(shape)) return shape;
  const solids = cad.getSubShapes(shape, "solid");
  return solids.length === 1 ? solids[0] : shape;
}

/** A closed wire through the given points, in the editor's Y-up frame. */
function wireThroughPoints(cad: OcctKernel, points: ProfilePoint[]) {
  const edges: ShapeHandle[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1, z1] = points[index];
    const [x2, y2, z2] = points[(index + 1) % points.length];
    edges.push(cad.makeLineEdge({ x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 }));
  }
  return cad.makeWire(edges);
}

function ellipseWire(cad: OcctKernel, radiusX: number, radiusZ: number, y: number) {
  const major = Math.max(radiusX, radiusZ);
  const minor = Math.min(radiusX, radiusZ);
  const wire = cad.makeWire([cad.makeEllipseEdge({ x: 0, y, z: 0 }, { x: 0, y: 1, z: 0 }, major, minor)]);
  // With a +Y normal the major radius lies along Z, so a shape wider than it is
  // deep needs the ellipse turned a quarter turn to match.
  return radiusX > radiusZ ? cad.rotate(wire, { ...Y_AXIS, point: { x: 0, y, z: 0 } }, Math.PI / 2) : wire;
}

/**
 * A primitive standing on Y, since OCCT builds cylinders and cones along Z.
 *
 * A quarter turn about X takes z into y, so a primitive spanning 0..height in Z
 * lands spanning 0..height in Y with no move needed.
 */
function standing(cad: OcctKernel, solid: ShapeHandle) {
  return cad.rotate(solid, X_AXIS, -Math.PI / 2);
}

function extrudedProfile(cad: OcctKernel, points: ProfilePoint[], height: number) {
  return cad.extrude(cad.makeFace(wireThroughPoints(cad, points)), 0, height, 0);
}

function loftedProfiles(cad: OcctKernel, bottom: ShapeHandle, top: ShapeHandle) {
  return cad.loft([bottom, top], true, true);
}

function flattenRing(points: ProfilePoint[], y: number): ProfilePoint[] {
  return points.map(([x, , z]) => [x, y, z]);
}

function rotatedRing(points: ProfilePoint[], degrees: number): ProfilePoint[] {
  if (!degrees) return points;
  const angle = degreesToRadians(degrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map(([x, y, z]) => [x * cos + z * sin, y, -x * sin + z * cos]);
}

function loftProfileSides(profile: LoftProfileShape) {
  if (profile === "Triangle") return 3;
  if (profile === "Pentagon") return 5;
  if (profile === "Hexagon") return 6;
  return 0;
}

function loftEndWire(cad: OcctKernel, profile: LoftProfileShape, width: number, depth: number, rotation: number, y: number) {
  if (profile === "Rectangle") {
    return wireThroughPoints(cad, rotatedRing(rectangleRing(width, depth, y), rotation));
  }
  if (isPolygonLoftShape(profile)) {
    return wireThroughPoints(cad, rotatedRing(polygonRing(width / 2, depth / 2, loftProfileSides(profile), y), rotation));
  }
  // An oval end is a true ellipse, so it stays analytic rather than becoming a
  // many-sided polygon.
  const wire = ellipseWire(cad, width / 2, depth / 2, y);
  return rotation ? cad.rotate(wire, { ...Y_AXIS, point: { x: 0, y, z: 0 } }, degreesToRadians(rotation)) : wire;
}

function taperedSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const plan = planTaper(shape, CIRCULAR_EPSILON);
  const height = shape.height;
  if (plan.kind === "cone") {
    return standing(cad, cad.makeCone(plan.bottomRadius, plan.topRadius, height));
  }
  if (plan.kind === "loft") {
    // planTaper measures from the shape's middle; everything here is built from
    // its base upwards, so both rings move up by half the height.
    const bottom = wireThroughPoints(cad, flattenRing(plan.bottom, 0));
    const top = wireThroughPoints(cad, flattenRing(plan.top, height));
    return loftedProfiles(cad, bottom, top);
  }
  throw new UnbuildableShapeError(`A taper on a ${shape.kind} has no exact geometry the server can build.`);
}

function cylinderSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  if (isFacetedCylinder(shape)) {
    return extrudedProfile(cad, polygonRing(width / 2, depth / 2, shape.sides as number, 0), height);
  }
  if (Math.abs(width - depth) < CIRCULAR_EPSILON) {
    return standing(cad, cad.makeCylinder(width / 2, height));
  }
  // Wider than it is deep: an elliptical cylinder, extruded from a true ellipse.
  return cad.extrude(cad.makeFace(ellipseWire(cad, width / 2, depth / 2, 0)), 0, height, 0);
}

/**
 * A tube or ring: a cylinder with its middle taken out.
 *
 * `bevel` carries the wall thickness for these kinds, measured inwards from the
 * outer radius, and the editor clamps it so a wall is always left -- matching
 * that clamp here keeps a thick-walled tube from becoming a solid rod.
 */
function hollowCylinderSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const outerX = shapeWidth(shape) / 2;
  const outerZ = shapeDepth(shape) / 2;
  const height = shape.height;
  const maxThickness = Math.max(0.1, Math.min(outerX, outerZ) - 0.1);
  const thickness = Math.min(Math.max(shape.bevel ?? 4, 0.1), maxThickness);
  const innerX = Math.max(0.1, outerX - thickness);
  const innerZ = Math.max(0.1, outerZ - thickness);

  const outer = cad.extrude(cad.makeFace(ellipseWire(cad, outerX, outerZ, 0)), 0, height, 0);
  // The bore runs past both ends so the cut leaves no skin on the openings.
  const bore = cad.translate(
    cad.extrude(cad.makeFace(ellipseWire(cad, innerX, innerZ, 0)), 0, height + 2, 0),
    0,
    -1,
    0,
  );
  return solidOf(cad, cad.cut(outer, bore));
}

function loftSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const bottomProfile = normalizeLoftShape(shape.loftBottomShape, DEFAULT_LOFT_BOTTOM_SHAPE);
  const topProfile = normalizeLoftShape(shape.loftTopShape, DEFAULT_LOFT_TOP_SHAPE);
  const bottom = loftEndWire(cad, bottomProfile, width, depth, shape.loftBottomRotation ?? 0, 0);
  const top = loftEndWire(
    cad,
    topProfile,
    normalizeLoftTopSize(shape.loftTopWidth, width),
    normalizeLoftTopSize(shape.loftTopDepth, depth),
    shape.loftTopRotation ?? 0,
    shape.height,
  );
  return loftedProfiles(cad, bottom, top);
}


/** A prism from a cross-section in the XY plane, centred on Z the way the editor draws it. */
function extrudedCrossSection(cad: OcctKernel, points: ProfilePoint[], depth: number) {
  const wire = wireThroughPoints(cad, points);
  const prism = cad.extrude(cad.makeFace(wire), 0, 0, depth);
  return cad.translate(prism, 0, 0, -depth / 2);
}

/** A gable roof: a triangular prism with its ridge over the middle. */
function roofSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const halfWidth = shapeWidth(shape) / 2;
  return extrudedCrossSection(cad, [
    [-halfWidth, 0, 0],
    [halfWidth, 0, 0],
    [0, shape.height, 0],
  ], shapeDepth(shape));
}

/** A wedge: the same prism with its ridge over one side, so one face is vertical. */
function wedgeSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const halfWidth = shapeWidth(shape) / 2;
  return extrudedCrossSection(cad, [
    [-halfWidth, 0, 0],
    [halfWidth, 0, 0],
    [halfWidth, shape.height, 0],
  ], shapeDepth(shape));
}

/**
 * A barrel roof: half an ellipse, extruded.
 *
 * The editor extrudes a half disc of the shape's half-width and then scales it
 * in Y to the height, which is an ellipse with those two semi-axes -- so this
 * builds that ellipse directly rather than a scaled circle.
 */
function roundRoofSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const halfWidth = shapeWidth(shape) / 2;
  const depth = shapeDepth(shape);
  const arc = cad.makeEllipseArc({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, halfWidth, shape.height, 0, Math.PI);
  const base = cad.makeLineEdge({ x: -halfWidth, y: 0, z: 0 }, { x: halfWidth, y: 0, z: 0 });
  const prism = cad.extrude(cad.makeFace(cad.makeWire([arc, base])), 0, 0, depth);
  return cad.translate(prism, 0, 0, -depth / 2);
}

/**
 * A pyramid: a base and one triangle per side, sewn into a solid.
 *
 * Lofting the base to an apex vertex gets the volume right but splits every
 * side in two, leaving a seam down each face that the editor's pyramid does
 * not have -- and a seam is a selectable edge, so it would show up when
 * choosing what to fillet. Building the faces outright keeps one per side.
 *
 * Four sides is a rectangle; any other count is the regular polygon the editor
 * builds, fitted to width and depth through the same footprint scale it uses.
 */
function pyramidSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const sides = Math.max(3, Math.round(shape.sides ?? 4));
  let ring: ProfilePoint[];
  let apex: ProfilePoint;
  if (sides === 4) {
    ring = rectangleRing(width, depth, 0);
    apex = [0, shape.height, 0];
  } else {
    const footprint = regularPolygonFootprintScale(width, depth, sides);
    ring = polygonRing(footprint.x, footprint.z, sides, 0)
      .map(([x, y, z]): ProfilePoint => [x + footprint.offsetX, y, z + footprint.offsetZ]);
    apex = [footprint.offsetX, shape.height, footprint.offsetZ];
  }

  const point = ([x, y, z]: ProfilePoint) => ({ x, y, z });
  const faces = [cad.makeFace(wireThroughPoints(cad, ring))];
  for (let index = 0; index < ring.length; index += 1) {
    const from = ring[index];
    const to = ring[(index + 1) % ring.length];
    faces.push(cad.makeFace(cad.makeWire([
      cad.makeLineEdge(point(from), point(to)),
      cad.makeLineEdge(point(to), point(apex)),
      cad.makeLineEdge(point(apex), point(from)),
    ])));
  }
  // Sewing takes the winding it is given, which can leave the solid inside out
  // -- a negative volume, and normals pointing the wrong way for any boolean
  // or export that follows.
  return solidOf(cad, cad.fixFaceOrientations(cad.sewAndSolidify(faces, 1e-6)));
}

/**
 * A torus, as the editor sizes one.
 *
 * Its tube radius comes from the height and its major radius from the smaller
 * of width and depth, and it is then stretched so the outer diameter matches
 * width and depth separately. Unlike every other kind here it is centred on
 * the workplane rather than sitting on it, which is what the editor draws.
 */
function torusSolid(cad: OcctKernel, shape: WorkplaneShape) {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const tubeRadius = Math.max(0.1, shape.height / 2);
  const majorRadius = Math.max(0.2, Math.min(width, depth) / 2 - tubeRadius);
  const ring = cad.rotate(cad.makeTorus(majorRadius, tubeRadius), X_AXIS, Math.PI / 2);
  const outerDiameter = (majorRadius + tubeRadius) * 2;
  const scaleX = width / Math.max(0.001, outerDiameter);
  const scaleZ = depth / Math.max(0.001, outerDiameter);
  if (Math.abs(scaleX - 1) < 1e-9 && Math.abs(scaleZ - 1) < 1e-9) return ring;
  return cad.generalTransform(ring, [scaleX, 0, 0, 0, 0, 1, 0, 0, 0, 0, scaleZ, 0]);
}

/**
 * The shape as an exact solid, sitting on y = 0 and centred on x = z = 0.
 *
 * Its own rotation is not applied here; `exactSolidForShape` does that, so a
 * builder only ever has to think about the shape's own form.
 */
function untransformedSolid(cad: OcctKernel, shape: WorkplaneShape) {
  if (shapeHasTaper(shape)) return taperedSolid(cad, shape);

  switch (shape.kind) {
    case "box":
      // From corners rather than `makeBox`, which builds from the origin
      // outwards: a box centred like every other kind is what lets a hole be
      // placed against it.
      return cad.makeBoxFromCorners(
        { x: -shapeWidth(shape) / 2, y: 0, z: -shapeDepth(shape) / 2 },
        { x: shapeWidth(shape) / 2, y: shape.height, z: shapeDepth(shape) / 2 },
      );
    case "cylinder":
      return cylinderSolid(cad, shape);
    case "cone":
      return standing(cad, cad.makeCone(shapeWidth(shape) / 2, shape.topRadius ?? 0, shape.height));
    case "sphere": {
      const solid = cad.makeEllipsoid(shapeWidth(shape) / 2, shape.height / 2, shapeDepth(shape) / 2);
      return cad.translate(solid, 0, shape.height / 2, 0);
    }
    case "loft":
      return loftSolid(cad, shape);
    case "polygon":
      // The editor builds this as a six-sided prism scaled to width and depth.
      return extrudedProfile(cad, polygonRing(shapeWidth(shape) / 2, shapeDepth(shape) / 2, 6, 0), shape.height);
    case "tube":
    case "ring":
      return hollowCylinderSolid(cad, shape);
    case "roof":
      return roofSolid(cad, shape);
    case "wedge":
      return wedgeSolid(cad, shape);
    case "roundRoof":
      return roundRoofSolid(cad, shape);
    case "pyramid":
      return pyramidSolid(cad, shape);
    case "torus":
      return torusSolid(cad, shape);
    case "halfSphere": {
      // An ellipsoid of the full height, with its lower half cut away, which is
      // the dome the editor draws.
      const radiusX = shapeWidth(shape) / 2;
      const radiusZ = shapeDepth(shape) / 2;
      const dome = cad.makeEllipsoid(radiusX, shape.height, radiusZ);
      const below = cad.translate(cad.makeBox(shapeWidth(shape) * 2, shape.height * 2, shapeDepth(shape) * 2), -shapeWidth(shape), -shape.height * 2, -shapeDepth(shape));
      return solidOf(cad, cad.cut(dome, below));
    }
    default:
      throw new UnbuildableShapeError(
        `The server cannot build exact geometry for a ${shape.kind}. Do it in the editor instead.`,
      );
  }
}

/** The kinds `exactSolidForShape` can build, for an error message to name. */
export const EXACT_SOLID_KINDS = [
  "box", "cylinder", "cone", "sphere", "halfSphere", "loft",
  "polygon", "tube", "ring", "roof", "roundRoof", "wedge", "pyramid", "torus",
] as const;

/**
 * The shape as an exact solid, turned the way it sits in the project.
 *
 * Rotation has to be baked in: the treated result is stored as a mesh with no
 * rotation of its own, so a shape filleted while turned would otherwise come
 * back straightened.
 */
export function exactSolidForShape(cad: OcctKernel, shape: WorkplaneShape) {
  let solid = untransformedSolid(cad, shape);
  const yaw = shape.rotation ?? 0;
  const pitch = shape.rotationX ?? 0;
  const roll = shape.rotationZ ?? 0;
  // The editor applies yaw about Y, then pitch about X, then roll about Z.
  if (yaw) solid = cad.rotate(solid, Y_AXIS, degreesToRadians(-yaw));
  if (pitch) solid = cad.rotate(solid, X_AXIS, degreesToRadians(pitch));
  if (roll) solid = cad.rotate(solid, { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, degreesToRadians(roll));
  return solid;
}

/** Whether a shape's rotation turns it at all, which decides if baking is needed. */
export function shapeIsTurned(shape: WorkplaneShape) {
  return Boolean(shape.rotation || shape.rotationX || shape.rotationZ);
}
