/**
 * Hollowing a solid with a wall of a given thickness, on any OCCT kernel.
 *
 * The REST endpoint (`serverCadShell.ts`) and the editor's CAD worker both
 * hollow through this module, so a part shelled in the browser and the same
 * part shelled over the API come out of the same code at the same tolerance.
 * It imports nothing Node-only: the caller hands it a kernel and a solid.
 *
 * OCCT does the work with `BRepOffsetAPI_MakeThickSolid`, which the bundled
 * kernel exposes as `shell`. Two things about it are worth knowing before
 * changing any of this, both found by measuring rather than by reading:
 *
 *  - With no faces removed it does not hollow anything. It returns the *inner*
 *    solid -- the original offset inwards by the thickness -- so a sealed
 *    hollow has to be the original cut by that, which is what `hollowedSolid`
 *    does. Asking it to hollow a closed solid directly gives you back a
 *    smaller solid part, which looks plausible and is not what was asked for.
 *  - A thickness that does not fit does not reliably fail. Past half the
 *    part it variously returns an empty compound, a solid that reports
 *    `isValid: false` with a correct bounding box, or the original solid
 *    untouched with every extent and the validity flag intact. Only the volume
 *    tells those apart from a real answer, which is why `hollowedSolid`
 *    measures it rather than trusting the call to throw.
 *
 * Refusals are `CadShellError`s carrying a `reason`, so the REST path can
 * answer with its English message and status while the editor says the same
 * thing in the person's language.
 */

import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";

/**
 * The precision OCCT reconstructs the thick solid at.
 *
 * `1e-6` is the kernel's own recommendation for a precise shell and matches
 * what brepjs uses; the looser `1e-3` survives more inputs but produces
 * different topology, which would make a part shelled in the editor disagree
 * with the same part shelled over the API.
 */
const SHELL_TOLERANCE = 1e-6;

/** How closely a face's normal must line up with an axis to be named for it. */
const AXIS_TOLERANCE = 1e-3;

/**
 * Names for the faces a request is likely to want open, by where they point.
 *
 * A caller that knows the geometry can name face indexes from the listing, but
 * nobody wants to list a box's faces to find out which one is the lid. The
 * directions are the solid's own axes: +Y up, +Z towards the viewer. Which of
 * several parallel faces a name means is settled by how far out each sits, so
 * the solid may stand anywhere.
 */
const FACE_DIRECTIONS = {
  top: { x: 0, y: 1, z: 0 },
  bottom: { x: 0, y: -1, z: 0 },
  right: { x: 1, y: 0, z: 0 },
  left: { x: -1, y: 0, z: 0 },
  front: { x: 0, y: 0, z: 1 },
  back: { x: 0, y: 0, z: -1 },
} as const satisfies Record<string, Vec3>;

export type FaceDirection = keyof typeof FACE_DIRECTIONS;

export const FACE_DIRECTION_NAMES = Object.keys(FACE_DIRECTIONS) as FaceDirection[];

/** What a shell request can be refused for, independent of how it is said. */
export type CadShellRefusal =
  | "thickness"
  | "no-volume"
  | "no-faces"
  | "face-index"
  | "direction"
  | "no-flat-face"
  | "every-face-open"
  | "too-thick"
  | "cannot-offset";

export class CadShellError extends Error {
  readonly reason: CadShellRefusal;
  /** The HTTP status the REST path answers with. */
  readonly status: number;

  constructor(reason: CadShellRefusal, message: string, status = 422) {
    super(message);
    this.name = "CadShellError";
    this.reason = reason;
    this.status = status;
  }
}

export type CadShellFace = {
  index: number;
  /** As OCCT names the underlying surface: `plane`, `cylinder`, `bspline`... */
  surfaceType: string;
  area: number;
  /** Area-weighted centre of the face, which is a real point on a curved one. */
  centroid: { x: number; y: number; z: number };
  /** The outward normal, or null for a surface that cannot report one. */
  normal: { x: number; y: number; z: number } | null;
  /**
   * The direction name this face answers to, when it is the outermost flat face
   * pointing that way. A cavity floor points up as surely as a lid does, so a
   * face only takes a name if nothing it is parallel to sits further out.
   */
  facing: FaceDirection | null;
};

export type CadShellRequest = {
  /** Wall thickness in mm, measured inwards from the surface. */
  thickness: number;
  /** Faces to leave open, as direction names or face indexes. */
  openFaces?: ReadonlyArray<number | string>;
};

/**
 * The normal pointing out of the solid at the middle of a face.
 *
 * Exported because the measurement endpoint needs the same normal to answer
 * "what is the angle between these two faces", and a second copy of this would
 * be free to drift from the one the face listing and the shell request agree on.
 */
export function faceOutwardNormal(cad: OcctKernel, face: ShapeHandle) {
  try {
    const bounds = cad.uvBounds(face);
    // `surfaceNormal` already accounts for the face's own orientation, so a
    // reversed face reports the normal pointing out of the solid rather than
    // the surface's natural one. Verified against a box's six faces and
    // against the inner faces of a hollow, where the two disagree.
    const normal = cad.surfaceNormal(face, (bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2);
    if (![normal.x, normal.y, normal.z].every(Number.isFinite)) return null;
    return normal;
  } catch {
    return null;
  }
}

function axisOf(normal: Vec3 | null): FaceDirection | null {
  if (!normal) return null;
  for (const name of FACE_DIRECTION_NAMES) {
    const direction = FACE_DIRECTIONS[name];
    const dot = normal.x * direction.x + normal.y * direction.y + normal.z * direction.z;
    if (dot > 1 - AXIS_TOLERANCE) return name;
  }
  return null;
}

/** How far out along its own direction a face sits, which is what settles a tie. */
function reachAlong(centroid: Vec3, direction: Vec3) {
  return centroid.x * direction.x + centroid.y * direction.y + centroid.z * direction.z;
}

/** A solid's faces in kernel order, with the direction each one answers to. */
export function describeShellFaces(cad: OcctKernel, solid: ShapeHandle): CadShellFace[] {
  const faces = cad.getSubShapes(solid, "face");
  const described = faces.map((handle, index) => {
    const normal = faceOutwardNormal(cad, handle);
    let surfaceType = "unknown";
    try {
      surfaceType = cad.surfaceType(handle);
    } catch {
      // Not every surface reports a type; the area and centroid still do.
    }
    const centroid = cad.getSurfaceCenterOfMass(handle);
    return {
      index,
      surfaceType,
      area: cad.getSurfaceArea(handle),
      centroid: { x: centroid.x, y: centroid.y, z: centroid.z },
      normal: normal ? { x: normal.x, y: normal.y, z: normal.z } : null,
      // A flat face is the only kind a direction name can mean: "the top" of a
      // sphere is a point on a curved surface, not a lid you can take off.
      axis: surfaceType === "plane" ? axisOf(normal) : null,
    };
  });

  // Several faces can point the same way -- the lid of a hollow box and the
  // floor of its cavity both point up -- so a name belongs to the outermost of
  // them. Without this, opening "top" on an already-hollow part would pick the
  // cavity floor and quietly produce nonsense.
  const furthest = new Map<FaceDirection, number>();
  for (const face of described) {
    if (!face.axis) continue;
    const reach = reachAlong(face.centroid, FACE_DIRECTIONS[face.axis]);
    const best = furthest.get(face.axis);
    if (best === undefined || reach > best) furthest.set(face.axis, reach);
  }

  return described.map(({ axis, ...face }) => ({
    ...face,
    facing:
      axis && Math.abs(reachAlong(face.centroid, FACE_DIRECTIONS[axis]) - (furthest.get(axis) ?? 0)) < AXIS_TOLERANCE
        ? axis
        : null,
  }));
}

/**
 * The face indexes a request's `openFaces` names, in listing order.
 *
 * Mixed on purpose: `["top"]` is what a script asking for a tray wants to write,
 * and an index from the listing is the only way to name a face that no direction
 * describes -- one wall of a hexagonal pot, say.
 */
export function resolveShellOpenFaces(requested: ReadonlyArray<number | string>, faces: ReadonlyArray<Pick<CadShellFace, "index" | "facing">>) {
  const chosen = new Set<number>();
  for (const entry of requested) {
    if (typeof entry === "number") {
      if (!Number.isInteger(entry) || entry < 0 || entry >= faces.length) {
        throw new CadShellError("face-index", `Face indexes must be between 0 and ${faces.length - 1}.`, 400);
      }
      chosen.add(entry);
      continue;
    }
    const name = entry.trim().toLowerCase();
    if (!(FACE_DIRECTION_NAMES as string[]).includes(name)) {
      throw new CadShellError(
        "direction",
        `"${entry}" is not a face direction. Use one of ${FACE_DIRECTION_NAMES.join(", ")}, or a face index from the face listing.`,
        400,
      );
    }
    const matched = faces.filter((face) => face.facing === name);
    if (matched.length === 0) {
      throw new CadShellError(
        "no-flat-face",
        `This shape has no flat ${name} face to open. Name a face index from the face listing instead.`,
        422,
      );
    }
    for (const face of matched) chosen.add(face.index);
  }
  return [...chosen].sort((left, right) => left - right);
}

/** The single solid inside whatever OCCT handed back, or the shape itself. */
function soleSolid(cad: OcctKernel, result: ShapeHandle) {
  const solids = cad.getSubShapes(result, "solid");
  return solids.length === 1 ? solids[0] : result;
}

export function shellVolumeOf(cad: OcctKernel, shape: ShapeHandle) {
  try {
    const volume = cad.getVolume(shape);
    return Number.isFinite(volume) ? volume : null;
  } catch {
    return null;
  }
}

const TOO_THICK =
  "That wall thickness is too large for this shape: hollowing it at that thickness leaves no cavity. Try a thinner wall.";

/**
 * What OCCT refusing outright actually means, as far as it can be told apart.
 *
 * A thickness that merely does not fit does not throw: it comes back as an
 * empty compound, a solid that fails its own validity check, or the original
 * untouched, all of which `hollowedSolid` catches by measuring. A throw is the
 * other failure, and it tracks the *kind of surface* rather than the number.
 *
 * It is not "curved": an analytic sphere, cylinder, cone and torus all offset
 * perfectly well. What fails is a **spline** skin -- OCCT will not offset one
 * inwards at any thickness or at any reconstruction tolerance (checked at 1e-6,
 * 1e-4, 1e-3 and 1e-2). In this app that is an elliptical ball, a loft, and
 * anything built by extruding a profile wire, because those surfaces are
 * splines however round they look.
 */
const CANNOT_OFFSET =
  "OCCT could not hollow this shape: its surfaces cannot be offset inwards into a sound solid. A shape whose skin is a spline rather than an analytic surface -- a ball with unequal radii, a loft -- fails this way at any wall thickness, however round it looks.";

/** Whether a handle is a solid OCCT itself will vouch for. */
function isSoundSolid(cad: OcctKernel, shape: ShapeHandle) {
  try {
    return cad.isSolid(shape) && Boolean(cad.isValid(shape));
  } catch {
    // An empty compound throws from `isValid` rather than reporting false.
    return false;
  }
}

/**
 * The hollowed solid, or a refusal.
 *
 * Both paths run through OCCT's thick-solid builder, which answers two
 * different questions depending on whether any face is removed -- see the
 * module note. The checks around it are not belt and braces: every one of them
 * has a real input that reaches it, and the order matters, because it is what
 * separates a wall that does not fit from a shape that cannot be hollowed at
 * all. The inward offset is measured before it is cut away, so a thickness
 * that collapses it is reported as a thickness rather than blamed on the
 * shape's surfaces.
 */
function hollowedSolid(cad: OcctKernel, solid: ShapeHandle, sourceVolume: number, thickness: number, openFaces: number[]) {
  let hollow: ShapeHandle;
  if (openFaces.length > 0) {
    const faces = cad.getSubShapes(solid, "face");
    try {
      hollow = cad.shell(
        solid,
        openFaces.map((index) => faces[index]),
        thickness,
        SHELL_TOLERANCE,
      );
    } catch {
      throw new CadShellError("cannot-offset", CANNOT_OFFSET);
    }
  } else {
    // No face removed: `shell` returns the inward offset solid rather than a
    // hollow, so the sealed void is the original cut by it.
    let inner: ShapeHandle;
    try {
      inner = cad.shell(solid, [], thickness, SHELL_TOLERANCE);
    } catch {
      throw new CadShellError("cannot-offset", CANNOT_OFFSET);
    }
    // The cavity, before it is a cavity. Past half the part this is an empty
    // compound, and cutting the solid by it throws -- which would otherwise
    // read as the shape's fault rather than the thickness's.
    const innerVolume = shellVolumeOf(cad, inner);
    if (!isSoundSolid(cad, inner) || innerVolume === null || innerVolume <= 0 || innerVolume >= sourceVolume) {
      throw new CadShellError("too-thick", TOO_THICK);
    }
    try {
      hollow = cad.cut(solid, inner);
    } catch {
      throw new CadShellError("cannot-offset", CANNOT_OFFSET);
    }
  }

  const result = soleSolid(cad, hollow);
  if (!isSoundSolid(cad, result)) throw new CadShellError("too-thick", TOO_THICK);

  const volume = shellVolumeOf(cad, result);
  if (volume === null || volume <= 0) throw new CadShellError("too-thick", TOO_THICK);
  // Past the thickness that fits, OCCT hands back the original solid with
  // every extent and the validity flag intact. Hollowing always removes the
  // cavity, so a result that weighs what it started at did nothing.
  if (volume >= sourceVolume * (1 - 1e-6)) throw new CadShellError("too-thick", TOO_THICK);

  return { solid: result, volume };
}

/**
 * Hollow `solid` out to a wall of `request.thickness`, leaving `openFaces` off.
 *
 * `faces` is the listing the request's indexes refer to; it is described from
 * the solid when not given. Returns the hollow and the volumes either side of
 * it, or throws a `CadShellError`.
 */
export function shellSolid(cad: OcctKernel, solid: ShapeHandle, request: CadShellRequest, faces = describeShellFaces(cad, solid)) {
  if (!Number.isFinite(request.thickness) || request.thickness <= 0) {
    throw new CadShellError("thickness", "The wall thickness must be greater than zero.", 400);
  }
  if (faces.length === 0) throw new CadShellError("no-faces", "That shape has no faces to hollow out.");

  const openFaces = resolveShellOpenFaces(request.openFaces ?? [], faces);
  if (openFaces.length === faces.length) {
    throw new CadShellError(
      "every-face-open",
      "Leaving every face open would remove the shape rather than hollow it. Leave at least one face closed.",
    );
  }

  const sourceVolume = shellVolumeOf(cad, solid);
  if (sourceVolume === null || sourceVolume <= 0) {
    throw new CadShellError("no-volume", "That shape has no volume to hollow out.");
  }
  const hollow = hollowedSolid(cad, solid, sourceVolume, request.thickness, openFaces);
  return { solid: hollow.solid, volume: hollow.volume, sourceVolume };
}
