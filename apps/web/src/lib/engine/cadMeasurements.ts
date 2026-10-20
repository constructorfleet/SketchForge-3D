/**
 * Deriving measurements from exact B-rep geometry.
 *
 * Everything here works on what the kernel reports about a curve or a surface —
 * its type, its parameter range, its length, its analytic radius — and never on
 * a tessellation. That distinction is the whole point of the feature: a
 * triangulated cylinder has no radius, only facets, and a measurement tool that
 * read the mesh would be wrong in exactly the cases someone reaches for it.
 *
 * A measurement that is not meaningful for the entity selected returns a reason
 * rather than a number. A plausible wrong radius is worse than an honest refusal.
 */

/**
 * Why there is no radius, instead of a guessed number.
 *
 * The first three answer for an edge and the last four for a face. They are one
 * set because a caller reads them off a single field without having to know
 * which entity it was looking at.
 */
export type RadiusUnavailableCode =
  | "notCircular"
  | "ellipseHasNoSingleRadius"
  | "degenerateCurve"
  | "notCurved"
  | "radiusVariesOverSurface"
  | "radiusNotReportedByKernel"
  | "degenerateSurface";

/** Why there is no angle. An angle is only defined between two flat faces. */
export type AngleUnavailableCode = "notPlanar" | "degenerateNormal";

/**
 * Why a measurement could not be taken.
 *
 * The two fields that carry a reason draw on disjoint halves of this -- a radius
 * is never missing because a face was not planar -- so each is typed to its own
 * half and this is the sum, for whatever only logs it.
 */
export type MeasurementUnavailableCode = RadiusUnavailableCode | AngleUnavailableCode;

export type MeasurementResult<T, C extends MeasurementUnavailableCode = MeasurementUnavailableCode> =
  | ({ available: true } & T)
  | { available: false; code: C };

function unavailable<T, C extends MeasurementUnavailableCode>(code: C): MeasurementResult<T, C> {
  return { available: false, code };
}

export type Vec3Like = { x: number; y: number; z: number };

const FULL_TURN = Math.PI * 2;

/**
 * How far round a circular edge runs, in radians.
 *
 * OCCT parameterises a `Geom_Circle` by angle, so the parameter range *is* the
 * sweep. A closed edge is taken as a full turn rather than trusting the range,
 * because a seam edge can come back with a range that has been re-based.
 */
export function arcSweepRadians(range: { first: number; last: number; closed: boolean }) {
  return range.closed ? FULL_TURN : range.last - range.first;
}

export type CircularEdge = {
  /** `curveType` from the kernel. */
  curveKind: string;
  /** `curveLength` from the kernel, in millimetres. */
  length: number;
  first: number;
  last: number;
  closed: boolean;
};

export type EdgeRadius = {
  radius: number;
  diameter: number;
  /** Radians the edge sweeps; a full circle is 2π. */
  sweepRadians: number;
};

/**
 * The radius and diameter of a circular edge.
 *
 * Arc length over swept angle, which for a circle is exact: a full circle gives
 * `length / 2π` and an arc gives `length / sweep`. Both come from the kernel's
 * own curve analysis, so a cylinder modelled at any tessellation quality
 * measures the same.
 *
 * An ellipse is refused rather than approximated. It has two semi-axes and no
 * single radius, and `length / sweep` on one would silently report the average —
 * a number that is plausible, wrong, and impossible to notice.
 */
export function circularEdgeRadius(edge: CircularEdge): MeasurementResult<EdgeRadius, RadiusUnavailableCode> {
  if (edge.curveKind === "ellipse") {
    return unavailable("ellipseHasNoSingleRadius");
  }
  if (edge.curveKind !== "circle") {
    return unavailable("notCircular");
  }
  const sweepRadians = arcSweepRadians(edge);
  if (!Number.isFinite(sweepRadians) || sweepRadians <= 0 || !Number.isFinite(edge.length) || edge.length <= 0) {
    return unavailable("degenerateCurve");
  }
  const radius = edge.length / sweepRadians;
  return { available: true, radius, diameter: radius * 2, sweepRadians };
}

export type FaceRadius = {
  radius: number;
  diameter: number;
};

/** The surfaces that have one radius over the whole face, so a single number describes them. */
const CONSTANT_RADIUS_SURFACES = new Set(["cylinder", "sphere"]);

/**
 * The radius of a face, if its surface has one and the kernel will say what it is.
 *
 * A cylinder and a sphere each have a single radius: every point is the same
 * distance from the axis or the centre, so one number is the whole truth.
 *
 * A cone does not -- it is wide at one end and narrow at the other, so whatever
 * point happened to be sampled would be reported as *the* radius of the face. A
 * torus has a tube radius and a ring radius with no way to say which was meant.
 * A spline has a different radius everywhere. Those are refused with the reason.
 *
 * The cylinder's radius comes from `getFaceCylinderData`, the kernel's own
 * cylinder accessor, and **not** from `surfaceCurvature`, which this build does
 * not report usably. Measured on a sphere of radius 13 and a cylinder of radius
 * 7.5, the four fields it returns do not match their names consistently between
 * the two: on the sphere `min` is -1/13, a principal curvature, while `max` is
 * 1/169, which is the Gaussian; on the cylinder `min` is -1/15, which is the
 * mean, while `mean` is -1/7.5, which is the principal. A radius derived from
 * any one field is therefore right for one of those surfaces and exactly a
 * factor of two wrong for the other -- a plausible number, in the one tool whose
 * whole purpose is not to produce those. So a sphere is refused too, with
 * `radiusNotReportedByKernel` to say that the geometry has a radius and this
 * kernel will not hand it over; the circular edge bounding it still measures
 * exactly, and that is the measurement the request is usually really after.
 */
export function faceRadius(
  surfaceKind: string,
  /** `getFaceCylinderData(face)?.radius`, or null when the kernel reported none. */
  cylinderRadius: number | null,
): MeasurementResult<FaceRadius, RadiusUnavailableCode> {
  if (surfaceKind === "plane") {
    return unavailable("notCurved");
  }
  if (!CONSTANT_RADIUS_SURFACES.has(surfaceKind)) {
    return unavailable("radiusVariesOverSurface");
  }
  if (surfaceKind !== "cylinder") {
    return unavailable("radiusNotReportedByKernel");
  }
  if (cylinderRadius === null || !Number.isFinite(cylinderRadius) || cylinderRadius <= 0) {
    return unavailable("degenerateSurface");
  }
  return { available: true, radius: cylinderRadius, diameter: cylinderRadius * 2 };
}

function magnitude(vector: Vec3Like) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

/**
 * The angle between two directions, in degrees, from 0 to 180.
 *
 * The dot product is clamped before `acos` because two normals that the kernel
 * reports as identical can land a rounding step outside [-1, 1], and `acos` of
 * 1.0000000000000002 is NaN.
 */
export function angleBetweenDegrees(a: Vec3Like, b: Vec3Like): MeasurementResult<{ angleDegrees: number }, AngleUnavailableCode> {
  const lengthA = magnitude(a);
  const lengthB = magnitude(b);
  if (!Number.isFinite(lengthA) || !Number.isFinite(lengthB) || lengthA <= 1e-12 || lengthB <= 1e-12) {
    return unavailable("degenerateNormal");
  }
  const cosine = (a.x * b.x + a.y * b.y + a.z * b.z) / (lengthA * lengthB);
  const angleDegrees = (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
  return { available: true, angleDegrees };
}

/**
 * The angle between two planar faces, measured between their outward normals.
 *
 * This is the convention a corner reads naturally: two faces meeting at the
 * square corner of a box have perpendicular outward normals and measure 90°.
 * Two opposite faces of that box have opposing normals and measure 180°, which
 * says they face away from each other — the planes themselves are parallel.
 *
 * Only planes have one angle between them. A cylinder's normal turns as you move
 * across it, so there is no single answer and the measurement is refused.
 */
export function planarFaceAngle(
  a: { surfaceKind: string; normal: Vec3Like },
  b: { surfaceKind: string; normal: Vec3Like },
): MeasurementResult<{ angleDegrees: number }, AngleUnavailableCode> {
  if (a.surfaceKind !== "plane" || b.surfaceKind !== "plane") {
    return unavailable("notPlanar");
  }
  return angleBetweenDegrees(a.normal, b.normal);
}
