/**
 * Hollowing a solid on the server, with a wall of a given thickness.
 *
 * This is the operation a 3D print needs most and the editor has never had: a
 * solid box weighs 8 grams of filament and a 2 mm-walled one weighs two, and a
 * box with its top face left open is a tray. OCCT does it with
 * `BRepOffsetAPI_MakeThickSolid`, which the bundled kernel exposes as `shell`.
 *
 * Node-only, and built on the same footing as the fillet endpoint: the shape is
 * rebuilt as true geometry rather than meshed, and the result is stored with
 * its exact BREP alongside the triangles, so a hollowed part still exports to
 * STEP and can still be filleted afterwards.
 *
 * Two things about `shell` are worth knowing before changing any of this, both
 * found by measuring rather than by reading:
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
 */

import type { OcctKernel, ShapeHandle, Vec3 } from "occt-wasm";
import { withCadKernel } from "@/lib/serverCadKernel";
import { meshedCadResult, orientedSolidForShape, ServerCadError, type ServerCadResult } from "@/lib/serverCadOperations";
import type { WorkplaneShape } from "@/types/sketchforge";

/**
 * The precision OCCT reconstructs the thick solid at.
 *
 * `1e-6` is the kernel's own recommendation for a precise shell and matches
 * what brepjs uses; the looser `1e-3` survives more inputs but produces
 * different topology, which would make a shelled part disagree with the same
 * part shelled in the editor's worker later.
 */
const SHELL_TOLERANCE = 1e-6;

/** How closely a face's normal must line up with an axis to be named for it. */
const AXIS_TOLERANCE = 1e-3;

/**
 * Names for the faces a request is likely to want open, by where they point.
 *
 * A caller that knows the geometry can name face indexes from the listing, but
 * nobody wants to list a box's faces to find out which one is the lid. The
 * local frame these resolve in is the one every geometry builder here produces:
 * centred in X and Z, base at Y=0, +Z towards the viewer.
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

export type ServerCadFace = {
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

export type ServerCadShellRequest = {
  /** Wall thickness in mm, measured inwards from the surface. */
  thickness: number;
  /** Faces to leave open, as direction names or indexes from the face listing. */
  openFaces?: ReadonlyArray<number | string>;
};

function outwardNormal(cad: OcctKernel, face: ShapeHandle) {
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

function faceSummaries(cad: OcctKernel, solid: ShapeHandle): ServerCadFace[] {
  const faces = cad.getSubShapes(solid, "face");
  const described = faces.map((handle, index) => {
    const normal = outwardNormal(cad, handle);
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

/** A shape's faces, numbered as a shell request refers to them by index. */
export function shapeFaces(shape: WorkplaneShape): Promise<ServerCadFace[]> {
  return withCadKernel((cad) => faceSummaries(cad, orientedSolidForShape(cad, shape)));
}

/**
 * The face indexes a request's `openFaces` names, in listing order.
 *
 * Mixed on purpose: `["top"]` is what a script asking for a tray wants to write,
 * and an index from the listing is the only way to name a face that no direction
 * describes -- one wall of a hexagonal pot, say.
 */
function resolveOpenFaces(requested: ReadonlyArray<number | string>, faces: ServerCadFace[]) {
  const chosen = new Set<number>();
  for (const entry of requested) {
    if (typeof entry === "number") {
      if (!Number.isInteger(entry) || entry < 0 || entry >= faces.length) {
        throw new ServerCadError(`Face indexes must be between 0 and ${faces.length - 1}.`, 400);
      }
      chosen.add(entry);
      continue;
    }
    const name = entry.trim().toLowerCase();
    if (!(FACE_DIRECTION_NAMES as string[]).includes(name)) {
      throw new ServerCadError(
        `"${entry}" is not a face direction. Use one of ${FACE_DIRECTION_NAMES.join(", ")}, or a face index from the face listing.`,
        400,
      );
    }
    const matched = faces.filter((face) => face.facing === name);
    if (matched.length === 0) {
      throw new ServerCadError(
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

function volumeOf(cad: OcctKernel, shape: ShapeHandle) {
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
 * other failure, and in this kernel it is the shape rather than the number:
 * every kind whose outside is one continuous curved skin -- sphere, torus,
 * cone, round-walled tube, barrel roof -- fails at every thickness, and at
 * every reconstruction tolerance the kernel offers.
 */
const CANNOT_OFFSET =
  "OCCT could not hollow this shape: its surfaces cannot be offset inwards into a sound solid. A shape whose outside is one continuous curved skin -- a sphere, a torus, a cone, a tube's round wall -- fails this way at any wall thickness.";

/** What a result OCCT built but cannot write out means, which is nothing good. */
const UNREADABLE =
  "The hollowed solid came out of OCCT in a state it cannot read back, so it has not been stored. Try a different wall thickness.";

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
function hollowedSolid(cad: OcctKernel, solid: ShapeHandle, thickness: number, openFaces: number[]) {
  const sourceVolume = volumeOf(cad, solid);
  if (sourceVolume === null || sourceVolume <= 0) {
    throw new ServerCadError("That shape has no volume to hollow out.");
  }

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
      throw new ServerCadError(CANNOT_OFFSET);
    }
  } else {
    // No face removed: `shell` returns the inward offset solid rather than a
    // hollow, so the sealed void is the original cut by it.
    let inner: ShapeHandle;
    try {
      inner = cad.shell(solid, [], thickness, SHELL_TOLERANCE);
    } catch {
      throw new ServerCadError(CANNOT_OFFSET);
    }
    // The cavity, before it is a cavity. Past half the part this is an empty
    // compound, and cutting the solid by it throws -- which would otherwise
    // read as the shape's fault rather than the thickness's.
    const innerVolume = volumeOf(cad, inner);
    if (!isSoundSolid(cad, inner) || innerVolume === null || innerVolume <= 0 || innerVolume >= sourceVolume) {
      throw new ServerCadError(TOO_THICK);
    }
    try {
      hollow = cad.cut(solid, inner);
    } catch {
      throw new ServerCadError(CANNOT_OFFSET);
    }
  }

  const result = soleSolid(cad, hollow);
  if (!isSoundSolid(cad, result)) throw new ServerCadError(TOO_THICK);

  const volume = volumeOf(cad, result);
  if (volume === null || volume <= 0) throw new ServerCadError(TOO_THICK);
  // Past the thickness that fits, OCCT hands back the original solid with
  // every extent and the validity flag intact. Hollowing always removes the
  // cavity, so a result that weighs what it started at did nothing.
  if (volume >= sourceVolume * (1 - 1e-6)) throw new ServerCadError(TOO_THICK);

  return result;
}

/**
 * Hollow a shape out and return the exact result with a mesh of it.
 *
 * Both halves are kept, as for a fillet: the BREP is what STEP export and any
 * later treatment work from, and the mesh is what the viewport draws.
 */
export function applyShell(shape: WorkplaneShape, request: ServerCadShellRequest): Promise<ServerCadResult> {
  if (!Number.isFinite(request.thickness) || request.thickness <= 0) {
    return Promise.reject(new ServerCadError("The wall thickness must be greater than zero.", 400));
  }

  return withCadKernel((cad) => {
    const solid = orientedSolidForShape(cad, shape);
    const faces = faceSummaries(cad, solid);
    if (faces.length === 0) throw new ServerCadError("That shape has no faces to hollow out.");

    const openFaces = resolveOpenFaces(request.openFaces ?? [], faces);
    if (openFaces.length === faces.length) {
      throw new ServerCadError(
        "Leaving every face open would remove the shape rather than hollow it. Leave at least one face closed.",
      );
    }

    const hollow = hollowedSolid(cad, solid, request.thickness, openFaces);
    try {
      return meshedCadResult(cad, hollow);
    } catch {
      // A hollowed loft reaches this: the solid passes every check OCCT can
      // answer and then `toBREP` reads past the end of its own memory. There
      // is nothing to store, so this has to be a refusal rather than a 500.
      throw new ServerCadError(UNREADABLE);
    }
  });
}
