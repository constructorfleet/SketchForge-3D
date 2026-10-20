/**
 * The geometry engine's public surface (upstream issue #55).
 *
 * `docs/ENGINE_EXTRACTION.md` section 5 names what belongs here, judged against
 * the two consumers that are real: the REST route handlers and an offline
 * macro. The engine's job is geometry and format; transport is not its job, and
 * neither is prose for a human -- `apiShapeSummary` and the English sentences
 * that go with an error code stay in the app, because they are the REST wire
 * shape rather than engine vocabulary.
 *
 * Nothing under `lib/engine/` may reach `@/i18n`, `@/components`, `react` or
 * `next`. `tests/unit/engineImportBoundary.test.ts` asserts it over the
 * transitive `@/` closure, type-only imports included, and lists the few edges
 * that still point back out of the directory so they cannot quietly multiply.
 *
 * This barrel is the surface, not the only door: a module already importing
 * `@/lib/engine/<module>` directly is not wrong, and the editor's many call
 * sites were deliberately left pointing at the modules rather than rewritten
 * to come through here. What the barrel buys is a single place that says what
 * the engine promises, which is what `packages/sketchforge-engine` becomes when
 * the directory moves out of the app (PR 6).
 */

// --- the project, as a document on disk -------------------------------------
export { directoryProjectStore, type ProjectDocument, type ProjectMetadata, type ProjectStore } from "@/lib/engine/projectStore";

// --- operations, on an Engine bound to a store -------------------------------
export {
  createEngine,
  type CutRequest,
  type Engine,
  type EngineFailure,
  type EngineResult,
  type ShapeWritten,
  type ShapesWritten,
} from "@/lib/engine/engine";

// --- the format -------------------------------------------------------------
export {
  exportSkfProject,
  importSkfProject,
  inspectSkfProjectPackage,
  SKF_FORMAT_VERSION,
  SKF_MEDIA_TYPE,
  type SkfProjectExportInput,
  type SkfRestoredProject,
} from "@/lib/engine/skfProject";

// --- shapes, from parameters -------------------------------------------------
export {
  REQUESTABLE_SHAPE_KINDS,
  shapeFromRequest,
  shapeWithRequestedChanges,
  type RequestableShapeKind,
  type ShapeChangeResult,
  type ShapeRequest,
} from "@/lib/engine/shapeRequests";
export { canonicalizeShape, withHoleMode } from "@/lib/engine/workplaneShapes";
export {
  parseRevolveRequest,
  resolveThreadRequest,
  revolvedShapeFromRequest,
  rebuiltRevolveShape,
  type ParsedRevolveRequest,
} from "@/lib/engine/revolveRequests";

// --- geometry ---------------------------------------------------------------
//
// Section 5 asks for one `meshForShape(shape, options?)`. There is no such
// function yet: the mesh dispatch over `shape.kind` is still inside
// `WorkplaneViewport.tsx`, and only the primitive builders beneath it came out
// (in #55). Exporting the builders says what exists rather than inventing a
// dispatch in a refactor that is supposed to change nothing.
export {
  createHalfSphereGeometry,
  createHollowCylinderGeometry,
  createPyramidGeometry,
  createRoofGeometry,
  createRoundRoofGeometry,
  createTorusGeometry,
  createWedgeGeometry,
  putGeometryOnBase,
  type PrimitiveGeometryOptions,
} from "@/lib/engine/primitiveGeometry";
export { exactSolidForShape, EXACT_SOLID_KINDS, UnbuildableShapeError } from "@/lib/engine/cadSolids";
export {
  ServerCadError,
  type ServerCadEdge,
  type ServerCadResult,
  type ServerCadTreatment,
} from "@/lib/engine/serverCadOperations";
export { FACE_DIRECTION_NAMES, type ServerCadFace, type ServerCadShellRequest } from "@/lib/engine/serverCadShell";
export {
  type MeasurementEndRef,
  type MeasurementEntityKind,
  type ServerCadMeasurement,
  type ServerCadMeasurementPair,
} from "@/lib/engine/serverCadMeasure";
export {
  type AngleUnavailableCode,
  type MeasurementUnavailableCode,
  type RadiusUnavailableCode,
} from "@/lib/engine/cadMeasurements";
export { exportShapesToStep, type StepExportResult } from "@/lib/engine/stepExport";
