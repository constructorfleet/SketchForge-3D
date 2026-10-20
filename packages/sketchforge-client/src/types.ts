/**
 * The wire shapes of `/api/v1`, typed.
 *
 * These mirror `apps/web/src/lib/shapeRequests.ts`, `revolveRequests.ts` and
 * `apiShapes.ts`. The server is forgiving -- an unknown field is ignored and a
 * missing one takes the editor's default -- so the types here are deliberately
 * tighter than the server's validation: a caller is better served by a compile
 * error on `sids: 6` than by a hexagon that came out round.
 */

/** Kinds the server can build from parameters alone, with no OCCT and no browser. */
export const PARAMETRIC_SHAPE_KINDS = [
  "box",
  "cube",
  "cylinder",
  "cone",
  "sphere",
  "halfSphere",
  "torus",
  "tube",
  "ring",
  "polygon",
  "pyramid",
  "roof",
  "roundRoof",
  "wedge",
  "icosahedron",
  "text",
  "loft",
  "gear",
] as const;

export type ParametricShapeKind = (typeof PARAMETRIC_SHAPE_KINDS)[number];

/** Every kind a shape request may name, including the two swept ones. */
export type ShapeKind = ParametricShapeKind | "revolve" | "thread";

/** Thread designations the server's catalog carries a pitch for. */
export const THREAD_DESIGNATIONS = [
  "M2",
  "M2.5",
  "M3",
  "M4",
  "M5",
  "M6",
  "M8",
  "M10",
  "M12",
  "M16",
  "M20",
  "#4-40",
  "#6-32",
  "#8-32",
  "#10-24",
  "1/4-20",
  "5/16-18",
  "3/8-16",
  "1/2-13",
] as const;

export type ThreadDesignation = (typeof THREAD_DESIGNATIONS)[number];

/** Dimensions outside this range are clamped by the server rather than refused. */
export const MIN_DIMENSION = 0.01;
export const MAX_DIMENSION = 10_000;

/** One POST may carry at most this many shapes. */
export const MAX_SHAPES_PER_REQUEST = 200;

export type ShapePlacement = {
  name?: string;
  /** A CSS hex colour, as the editor stores it. */
  color?: string;
  x?: number;
  z?: number;
  elevation?: number;
  rotation?: number;
  rotationX?: number;
  rotationZ?: number;
  /** Marked as a hole, so grouping it with a solid subtracts it. */
  hole?: boolean;
};

export type ShapeDimensions = {
  width?: number;
  depth?: number;
  height?: number;
  /** Stands in for all three, which is what `cube` is for. */
  size?: number;
};

export type LoftProfileShape = "square" | "circle" | "triangle" | "hexagon";

type KindFields = {
  box: unknown;
  cube: unknown;
  /** `sides` under 96 is a prism rather than a cylinder; 6 gives a hex bar. */
  cylinder: { sides?: number };
  cone: { sides?: number; topRadius?: number };
  sphere: { steps?: number };
  halfSphere: { steps?: number };
  torus: unknown;
  /** `bevel` is the wall thickness, measured inwards. */
  tube: { bevel?: number };
  ring: { bevel?: number };
  polygon: unknown;
  pyramid: { sides?: number };
  roof: unknown;
  roundRoof: unknown;
  wedge: unknown;
  icosahedron: unknown;
  text: { text?: string; font?: string; bevel?: number; segments?: number };
  loft: {
    loftBottomShape?: LoftProfileShape;
    loftTopShape?: LoftProfileShape;
    loftTopWidth?: number;
    loftTopDepth?: number;
    loftBottomRotation?: number;
    loftTopRotation?: number;
    loftSegments?: number;
    loftLayers?: number;
  };
  gear: {
    teeth?: number;
    toothSize?: number;
    toothWidth?: number;
    centerHoleSize?: number;
    helixAngle?: number;
  };
};

export type ParametricShapeRequest = {
  [Kind in ParametricShapeKind]: { kind: Kind } & ShapePlacement &
    ShapeDimensions &
    (KindFields[Kind] extends object ? KindFields[Kind] : Record<never, never>);
}[ParametricShapeKind];

/** A point of a revolve outline: `[distance from the axis, position along it]`. */
export type ProfilePoint = readonly [number, number];

export type RevolveSettings = {
  /** Axial rise per full turn, in mm. `0` is a plain revolve; negative is left-hand. */
  pitch?: number;
  /** Full turns to sweep, 0.1 to 20. */
  turns?: number;
  startAngle?: number;
  /** How far round to revolve when there is no pitch, +/-360. */
  sweepAngle?: number;
  /** The solid the sweep is fused into. `0` leaves the bare ribbon. */
  coreRadius?: number;
};

export type RevolveShapeRequest = { kind: "revolve"; profile: readonly ProfilePoint[] } &
  RevolveSettings &
  ShapePlacement;

export type ThreadShapeRequest = {
  kind: "thread";
  /** A catalog designation, which carries its own pitch. Defaults to `M8`. */
  size?: ThreadDesignation | string;
  /** Outside diameter, for a size the catalog does not list. */
  diameter?: number;
  pitch?: number;
  turns?: number;
  /** How long the thread should be, instead of counting turns. */
  length?: number;
  /** Cut wider by a clearance and marked as a hole, so a bolt of that size fits. */
  hole?: boolean;
  clearance?: number;
  /** `false` leaves the bare helix, with no shank and no drilled hole. */
  core?: boolean;
  /** Overrides the catalog's 60-degree V. */
  profile?: readonly ProfilePoint[];
} & ShapePlacement;

export type ShapeRequest = ParametricShapeRequest | RevolveShapeRequest | ThreadShapeRequest;

/** The fields a PATCH may change. Anything else needs a new shape. */
export type ShapePatch = ShapePlacement &
  Pick<ShapeDimensions, "width" | "depth" | "height"> & {
    locked?: boolean;
    hidden?: boolean;
  };

/**
 * A shape as the server reports it.
 *
 * `kind` is the stored kind rather than the requested one: a `cube` comes back
 * as a `box`, and a `revolve` or `thread` as a `mesh`, because that is what the
 * project holds.
 */
export type ShapeSummary = {
  id: string;
  name: string;
  kind: string;
  color: string;
  hole: boolean;
  locked: boolean;
  hidden: boolean;
  x: number;
  z: number;
  elevation: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  rotationX: number;
  rotationZ: number;
  sides?: number;
  text?: string;
  groupedCount?: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  /** How many shapes the project holds. */
  shapes: number;
  revision: number;
  updatedAt: number;
  packageBytes: number;
};

export type ProjectSnapGrid = { enabled?: boolean; size?: number } & Record<string, unknown>;

export type ProjectDetail = {
  id: string;
  name: string;
  createdAt: number;
  snapGrid: ProjectSnapGrid;
  workspace: Record<string, unknown>;
  shapes: ShapeSummary[];
};

export type EdgeSummary = {
  index: number;
  length: number;
  /** As OCCT names it: `line`, `circle`, `bspline`, or `unknown`. */
  curveType: string;
  midpoint: { x: number; y: number; z: number };
  /**
   * Whether a fillet or chamfer can act on this edge. A seam -- where one
   * curved surface meets itself -- has no two faces to blend, and naming one
   * explicitly is an error rather than a silent skip.
   */
  filletable: boolean;
};

export type EdgeTreatment = {
  kind: "fillet" | "chamfer";
  /** Fillet radius or chamfer distance, in mm. */
  amount: number;
  /** Chamfers only; 45 is symmetric. */
  angle?: number;
  /** Edge indexes from the edge listing, or omitted for every edge that can be treated. */
  edges?: readonly number[];
};

export type ShapeWriteResult = { shapes: ShapeSummary[]; revision: number };
export type ShapePatchResult = { shape: ShapeSummary; revision: number };
export type TreatmentResult = { shape: ShapeSummary; triangles: number; revision: number };
export type DeleteResult = { deleted: true; id: string; revision?: number };
