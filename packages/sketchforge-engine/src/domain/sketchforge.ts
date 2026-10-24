import type { CameraProjection } from "./cameraProjection.js";

export type ShapeKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "sketch"
  | "scribble"
  | "cone"
  | "pyramid"
  | "roof"
  | "text"
  | "roundRoof"
  | "halfSphere"
  | "torus"
  | "tube"
  | "gear"
  | "ring"
  | "wedge"
  | "polygon"
  | "icosahedron"
  | "mesh"
  | "loft";

export type ShapeAsset = {
  id: string;
  name: string;
  src: string;
  kind: ShapeKind;
  color: string;
  hole?: boolean;
};

export type ProjectAssetSourceFormat = "stl" | "obj" | "svg" | "step";

export type ProjectAsset = {
  id: string;
  name: string;
  mediaType: string;
  sourceFormat: ProjectAssetSourceFormat;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
};

export type GridSize = "Off" | "0.1 mm" | "0.25 mm" | "0.5 mm" | "1.0 mm" | "2.0 mm" | "5.0 mm" | "Brick";
export type MeasurementAccuracy = 1 | 2 | 3;
export type HistoryRetentionLimit = "unlimited" | number;

export type ShapeCustomization = {
  width?: number;
  depth?: number;
  height?: number;
  maxDimension?: number;
  steps?: number;
  sides?: number;
  bevel?: number;
  segments?: number;
  topRadius?: number;
  baseRadius?: number;
  teeth?: number;
  toothSize?: number;
  toothWidth?: number;
  centerHoleSize?: number;
  gearType?: GearType;
  helixAngle?: number;
  helixQuality?: number;
  text?: string;
  font?: string;
  loftBottomShape?: LoftProfileShape;
  loftTopShape?: LoftProfileShape;
  loftTopWidth?: number;
  loftTopDepth?: number;
  loftBottomRotation?: number;
  loftTopRotation?: number;
  loftSegments?: number;
  loftLayers?: number;
};

export type ShapeCustomizationMap = Partial<Record<ShapeKind, ShapeCustomization>>;

export type CameraView = {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  /** Orthographic magnification. Perspective framing is encoded by camera distance. */
  zoom: number;
};

export type WorkplaneWorkspaceSettings = {
  width: number;
  depth: number;
  sizePreset: string;
  gridBlockSize: number;
  gridBlockPreset: string;
  gridColor: string;
  background: string;
  showShadows: boolean;
  showGrid: boolean;
  cruiseShapes: boolean;
  selectBeforeMove: boolean;
  zoomSpeed: number;
  /** Projection the viewport camera uses. See lib/cameraProjection.ts. */
  cameraProjection: CameraProjection;
  /** Last settled viewport pose, absent in projects saved before camera persistence. */
  cameraView?: CameraView;
  units: string;
  scale: string;
  accuracy: MeasurementAccuracy;
  historyLimit: HistoryRetentionLimit;
  shapeCustomizations: ShapeCustomizationMap;
  /**
   * Price per kilogram per material preset id, overriding the preset default.
   * Only materials the user has repriced appear here.
   */
  materialPricesPerKg: Record<string, number>;
};

export type AlignAxis = "x" | "y" | "z";
export type AlignTarget = "min" | "center" | "max";
export type AlignHandleStatus = {
  axis: AlignAxis;
  target: AlignTarget;
  disabled: boolean;
  aligned: boolean;
  title: string;
};

export type SketchPoint = {
  id: string;
  x: number;
  z: number;
  sweepRole?: "section" | "spine";
  /** Millimeter offset along the section workplane's third axis for 3D sweep spine points and cubic handles. */
  sweepDepth?: number;
  handleIn?: { x: number; z: number; sweepDepth?: number };
  handleOut?: { x: number; z: number; sweepDepth?: number };
  mode?: "corner" | "smooth" | "split";
};

export type SketchSweepFrame = {
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  xAxis: { x: number; y: number; z: number };
  zAxis: { x: number; y: number; z: number };
};

export type SketchSegment = {
  id: string;
  startId: string;
  endId: string;
  kind?: "line" | "bezier" | "smooth";
};

export type SketchConstraint =
  | { id: string; kind: "fixed"; pointId: string; xMm: number; zMm: number }
  | { id: string; kind: "coincident"; pointIds: [string, string] }
  | { id: string; kind: "horizontal"; segmentId: string }
  | { id: string; kind: "vertical"; segmentId: string }
  | { id: string; kind: "parallel"; segmentIds: [string, string] }
  | { id: string; kind: "perpendicular"; segmentIds: [string, string] }
  | { id: string; kind: "distance"; pointIds: [string, string]; valueMm: number };

export type SketchImage = {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  pixelWidth: number;
  pixelHeight: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  opacity?: number;
  lockAspect?: boolean;
  locked?: boolean;
};

export type SketchProfile = {
  points: SketchPoint[];
  segments: SketchSegment[];
  constraints?: SketchConstraint[];
  images?: SketchImage[];
  sweepFrames?: { section: SketchSweepFrame; spine: SketchSweepFrame };
};

export type SketchOperation = "extrude" | "revolve" | "sweep";

export type GearType = "spur" | "helical" | "bevel";

export type LoftProfileShape = "Oval" | "Rectangle" | "Triangle" | "Pentagon" | "Hexagon";

export type SketchRevolveSettings = {
  startAngle: number;
  sweepAngle: number;
  sides: number;
  quality: number;
  /**
   * Axial rise per full turn, in mm. Zero is a plain revolve.
   *
   * The sign is the handedness: positive rises as it turns, which is a
   * right-hand thread, and negative is a left-hand one.
   */
  pitch: number;
  /** Full turns to sweep when `pitch` is set; `sweepAngle` governs a plain revolve. */
  turns: number;
  /**
   * Radius of a solid core the sweep is fused to, or 0 for none.
   *
   * A thread on its own is a floating helical ribbon. A bolt is that ribbon
   * around a shank, and a tapped hole is the ribbon plus the drilled hole it
   * cuts -- in both cases the core is part of the feature, not an extra.
   */
  coreRadius: number;
};

export type EdgeTreatmentFeature = {
  kind: "fillet" | "chamfer";
  amount: number;
  edgeCount: number;
  chamferAngle?: number;
  /** The operation selected every currently available edge, so it can be replayed without topology indices. */
  allEdges?: true;
};

export type EdgeTreatmentHistoryEntry = {
  id: string;
  createdAt: number;
  feature: EdgeTreatmentFeature;
  before: WorkplaneShape;
  appliedFrame?: {
    x: number;
    z: number;
    elevation: number;
    width: number;
    depth: number;
    height: number;
    rotation: number;
    rotationX: number;
    rotationZ: number;
    mirrorX: boolean;
    mirrorY: boolean;
    mirrorZ: boolean;
  };
};

export type CadDisplayEdge = {
  points: number[];
};

export type CadBrepFrame = {
  x: number;
  z: number;
  elevation: number;
  width: number;
  depth: number;
  height: number;
  sourceTransform?: number[];
};

export type CadPrimitiveFrame = {
  kind: "box";
  width: number;
  depth: number;
  height: number;
  frame: CadBrepFrame;
};

export type SketchFaceDraft = {
  /** Stable application face ID selected on the undrafted source extrusion. */
  sourceFaceId: string;
  angle: number;
  pullDirection: "x" | "y" | "z" | "-x" | "-y" | "-z";
  /** Persisted matching evidence; used to resolve the source face after rebuild. */
  sourceFaceNormal: { x: number; y: number; z: number };
};

export type WorkplaneShape = {
  id: string;
  name: string;
  kind: ShapeKind;
  color: string;
  /**
   * Chosen material preset id (see lib/materialPresets). Absent means none was
   * chosen, which is what every project written before materials existed says.
   * A value this build does not recognise is kept as-is rather than coerced.
   */
  material?: string;
  /** General surface appearance for viewport rendering; separate from print material estimates. */
  appearance?: ShapeAppearance;
  /** App-owned face identifiers in CAD listing order. Persisted with the shape. */
  faceIds?: string[];
  /** Face colors keyed by stable face ID; numeric keys remain readable for old projects. */
  faceColors?: Record<string, string>;
  /** Bounded STEP product hierarchy from the retained source, when available. */
  stepAssembly?: StepAssemblyNode[];
  /** Source occurrence identity and ancestry for an independently selectable exploded STEP component. */
  stepComponent?: StepComponent;
  hole?: boolean;
  x: number;
  z: number;
  elevation?: number;
  size: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  rotationX?: number;
  rotationZ?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  mirrorZ?: boolean;
  radius?: number;
  steps?: number;
  sides?: number;
  bevel?: number;
  segments?: number;
  topRadius?: number;
  baseRadius?: number;
  taperTopWidth?: number;
  taperTopDepth?: number;
  taperBottomWidth?: number;
  taperBottomDepth?: number;
  /** Legacy local-dev taper fields kept for compatibility with in-progress projects. */
  taperTopScale?: number;
  taperBottomScale?: number;
  teeth?: number;
  toothSize?: number;
  toothWidth?: number;
  centerHoleSize?: number;
  gearType?: GearType;
  helixAngle?: number;
  helixQuality?: number;
  loftBottomShape?: LoftProfileShape;
  loftTopShape?: LoftProfileShape;
  loftTopWidth?: number;
  loftTopDepth?: number;
  loftBottomRotation?: number;
  loftTopRotation?: number;
  loftSegments?: number;
  loftLayers?: number;
  text?: string;
  font?: string;
  importedMesh?: {
    positions: number[];
    normals?: number[];
    baseWidth: number;
    baseDepth: number;
    baseHeight: number;
    triangleCount: number;
    sourceFormat: "stl" | "obj" | "svg" | "json" | "step";
    // Compact triangle ranges mapping the STEP mesh to current CAD face indexes.
    // Each triple is [triangleStart, triangleCount, faceIndex].
    faceGroups?: number[];
    // IndexedDB persistence uses this only in compact stored shape records.
    // Runtime editor shapes are hydrated with the full immutable mesh resource.
    storageResourceId?: string;
    // Stable reference to the original imported file in the project's shared
    // asset table. Copies and grouped operands reuse this reference.
    assetId?: string;
    // Exact OpenCascade B-Rep of the body (single-shape STEP text) in the same
    // local frame as `positions`. Set only for STEP imports; lets the exporter
    // re-emit the original analytic geometry instead of the tessellation.
    brepStep?: string;
  };
  imagePlate?: {
    dataUrl: string;
    mimeType: string;
    pixelWidth: number;
    pixelHeight: number;
  };
  sketchProfile?: SketchProfile;
  sketchOperation?: SketchOperation;
  /** Stable identity of the editable sketch consumed by this sketch feature. */
  sketchSourceId?: string;
  sketchRevolve?: SketchRevolveSettings;
  /** Non-zero prism draft angle retained so source sketch edits can rebuild the feature. */
  draftPrismAngle?: number;
  /** Sketch extrusion dimensions/frame before draft, retained as rebuild inputs. */
  draftPrismSourceHeight?: number;
  draftPrismSourceFrame?: CadBrepFrame;
  /** One editable face draft on a retained sketch extrusion. */
  faceDraft?: SketchFaceDraft;
  /** Source face IDs available for exact face-draft reselection on this source profile. */
  faceDraftSourceFaceIds?: string[];
  /** Sketch profile segment identity for a straight extrusion side-face draft. */
  faceDraftSourceSegmentId?: string;
  /** Original extrusion frame used to keep face-draft source edits in place. */
  faceDraftSourceFrame?: CadBrepFrame;
  /** Original revolve resize ratios, retained for profile replay after drafting. */
  faceDraftSourceScale?: { width: number; depth: number; height: number };
  edgeTreatments?: EdgeTreatmentFeature[];
  edgeTreatmentHistory?: EdgeTreatmentHistoryEntry[];
  /**
   * A shell baked into `cadBrep`. Nothing can replay it, so a rebuild from the
   * source sketch is refused rather than returning the solid body.
   */
  shell?: { thickness: number; openFaces?: Array<number | string> };
  cadDisplayEdges?: CadDisplayEdge[];
  cadDisplayEdgesVersion?: 2;
  edgeResizeMode?: "scale" | "preserve";
  cadBrep?: string;
  cadBrepFrame?: CadBrepFrame;
  cadPrimitiveFrame?: CadPrimitiveFrame;
  groupedShapes?: WorkplaneShape[];
  groupedBaseWidth?: number;
  groupedBaseDepth?: number;
  groupedBaseHeight?: number;
  groupOperation?: "group" | "intersection";
  locked?: boolean;
  hidden?: boolean;
};

/** Product label and its direct assembly children as read from a STEP source. */
export type StepAssemblyNode = { id?: string; name: string; children: StepAssemblyNode[] };

export type StepAssemblyPathNode = { id?: string; name: string };

/** Persisted ancestry for a selectable solid produced by exploding a STEP assembly. */
export type StepComponent = {
  /** Unique solid identity within this imported occurrence. */
  id: string;
  /** Product occurrence identity in the original STEP hierarchy. */
  occurrenceId: string;
  /** Root-to-component path, including the component itself. */
  path: StepAssemblyPathNode[];
};

/** Persisted per-shape surface appearance. Values are normalized to [0, 1] by the renderer. */
export type ShapeAppearance = {
  /** Reusable built-in starting point such as wood, fabric, ceramic, or metal. */
  presetId?: string;
  /** Optional color override. When absent, a preset color or legacy shape.color is used. */
  baseColor?: string;
  roughness?: number;
  metalness?: number;
  /** Three.js physical-material sheen intensity, useful for fabric-like surfaces. */
  sheen?: number;
};
