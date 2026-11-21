/** Public API for SketchForge's project, geometry, import, export and CAD operations. */

// --- the project, as a document on disk -------------------------------------
export { directoryProjectStore, type ProjectDocument, type ProjectMetadata, type ProjectStore } from "./projectStore.js";

// --- operations, on an Engine bound to a store -------------------------------
export {
  createEngine,
  type AlignOutcome,
  type AlignRequest,
  type CutRequest,
  type DistributeOutcome,
  type DistributeRequest,
  type Engine,
  type EngineFailure,
  type EngineResult,
  type MeshImportRequest,
  type ParametersWritten,
  type PatternKind,
  type PatternRequest,
  type ProjectRead,
  type ShapeRemoved,
  type ShapesArranged,
  type ShapeWritten,
  type ShapesWritten,
} from "./engine.js";
export type { ServerCadShapeProperties, ShapeGeometryProvenance } from "./serverCadProperties.js";
export { MAX_INTERFERENCE_CANDIDATES, MAX_INTERFERENCE_SHAPES } from "./serverCadInterference.js";
export type { InterferencePair, InterferenceReport, InterferenceRequest, InterferenceRefusal } from "./serverCadInterference.js";

// --- arranging what is already there -----------------------------------------
//
// Pure arithmetic over extents, shared by the editor and the operations above.
// The editor measures the extents off the mesh and the engine measures them off
// the parameters; the spacing rules are the same either way.
export {
  alignCoordinate,
  alignShifts,
  effectiveAlignAnchorId,
  ALIGN_EPSILON,
  type AlignAxis,
  type AlignEntry,
  type AlignShift,
  type AlignTarget,
} from "./alignShapes.js";
export {
  distributeShifts,
  widestDistributeAxis,
  type DistributeEntry,
  type DistributeShift,
  type DistributeSpacing,
} from "./distributeShapes.js";
export {
  circularPatternPlacements,
  linearPatternPlacements,
  suggestedLinearStep,
  MAX_PATTERN_COUNT,
  MIN_PATTERN_COUNT,
  type CircularPatternRequest,
  type LinearPatternRequest,
  type PatternPlacement,
} from "./patternShapes.js";
export { boundsForShapes, footprintCenter, shapeBounds, type ShapeBounds } from "./shapeBounds.js";

// --- importing a model file ---------------------------------------------------
export {
  importableMeshFormat,
  importedMeshFromFile,
  IMPORTABLE_MESH_FORMATS,
  type ImportableMeshFormat,
  type ImportedMesh,
} from "./meshImport.js";

// --- the format -------------------------------------------------------------
export {
  exportSkfProject,
  importSkfProject,
  inspectSkfProjectPackage,
  SKF_FORMAT_VERSION,
  SKF_MEDIA_TYPE,
  type SkfProjectExportInput,
  type SkfRestoredProject,
} from "./skfProject.js";

// --- shapes, from parameters -------------------------------------------------
export {
  REQUESTABLE_SHAPE_KINDS,
  shapeFromRequest,
  shapeWithRequestedChanges,
  type RequestableShapeKind,
  type ShapeChangeResult,
  type ShapeRequest,
} from "./shapeRequests.js";
export { canonicalizeShape, withHoleMode } from "./workplaneShapes.js";
export {
  parseRevolveRequest,
  resolveThreadRequest,
  revolvedShapeFromRequest,
  rebuiltRevolveShape,
  revolveAxisPosition,
  bakedRevolveAxisOffset,
  reportedRevolveAxis,
  placeRevolveOnAxis,
  recoveredRevolveAxis,
  type ParsedRevolveRequest,
  type RevolveAxis,
} from "./revolveRequests.js";

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
} from "./primitiveGeometry.js";
export { exactSolidForShape, EXACT_SOLID_KINDS, UnbuildableShapeError } from "./cadSolids.js";
export {
  ServerCadError,
  applyDraftPrism,
  type ServerCadEdge,
  type ServerCadResult,
  type ServerCadTreatment,
} from "./serverCadOperations.js";
export { FACE_DIRECTION_NAMES, type ServerCadFace, type ServerCadShellRequest } from "./serverCadShell.js";
export {
  type MeasurementEndRef,
  type MeasurementEntityKind,
  type ServerCadMeasurement,
  type ServerCadMeasurementPair,
} from "./serverCadMeasure.js";
export {
  type AngleUnavailableCode,
  type MeasurementUnavailableCode,
  type RadiusUnavailableCode,
} from "./cadMeasurements.js";
export { exportShapesToStep, type StepExportResult } from "./stepExport.js";
export { exportProjectScene, PROJECT_EXPORT_FORMATS, type ProjectExportArtifact, type ProjectExportFormat, type ProjectExportOptions } from "./sceneExport.js";
export {
  parseProjectionLayout,
  projectionLayoutForCaptureFace,
  PROJECTION_LAYOUTS,
  PROJECTION_VIEWS,
  type ProjectionLayout,
  type ProjectionView,
} from "./cadProjection.js";
export { meshProjectShapes } from "./projectMeshes.js";
export { renderSectionSvg, SECTION_PLANES, type SectionDrawing, type SectionPlane } from "./cadSection.js";
export { sectionShapesToDxf, sectionShapesToSvg, type SectionOptions } from "./serverCadSection.js";
export { renderSectionDxf } from "./cadSection.js";
export { wallThickness, type WallThicknessResult } from "./serverCadThickness.js";
export { explodeStepAssembly, MAX_EXPLODE_SOLIDS, MAX_EXPLODE_SOURCE_BYTES } from "./serverStepExplode.js";
export { analyzeMeshTopology, type TriangleFace } from "./meshValidation.js";
export { mirrorShapes } from "./serverShapeGroups.js";

// --- parameters ---------------------------------------------------------------
export {
  DIMENSIONS,
  EXPRESSION_FUNCTIONS,
  EXPRESSION_UNITS,
  evaluateExpression,
  expressionDependencies,
  formatDimension,
  isValidParameterName,
  renameExpressionReference,
  resolveParameterTable,
  type Dimension,
  type DimensionName,
  type ExpressionError,
  type ExpressionErrorCode,
  type ExpressionQuantity,
  type ExpressionResult,
  type ExpressionScope,
  type ExpressionSpan,
  type ParameterTableEntry,
  type ParameterTableResult,
} from "./parameterExpressions.js";
export {
  activateConfiguration,
  addConfiguration,
  addParameter,
  clearConfigurationOverride,
  configurationDependents,
  configurationIssues,
  deleteConfiguration,
  deleteParameter,
  isValidConfigurationName,
  parameterDependents,
  projectConfigurationError,
  projectParameterDependents,
  PROJECT_CONFIGURATION_LIMIT,
  PROJECT_PARAMETER_DIMENSIONS,
  PROJECT_PARAMETER_LIMIT,
  renameConfiguration,
  renameParameter,
  resolveConfiguration,
  resolveConfiguredParameters,
  resolveProjectParameters,
  setConfigurationOverride,
  updateParameter,
  type ProjectConfigurationInput,
  type ProjectConfigurationIssue,
  type ProjectParameterError,
  type ProjectParameterErrorCode,
  type ProjectParameterHolder,
  type ProjectParameterInput,
  type ProjectParameterResult,
  type ResolvedProjectParameters,
} from "./projectParameters.js";
export type { ProjectConfiguration, ProjectParameter, ProjectParameterDimension } from "./domain/sketchforge.js";
export type { ProjectConfigurationState } from "./editorHistory.js";
export {
  bindableField,
  bindableFieldsFor,
  boundFieldsNamedBy,
  boundFieldValue,
  EXPRESSION_BINDABLE_FIELDS,
  parameterScope,
  parameterShapeDependents,
  renameShapeBindingReferences,
  resolveShapeBinding,
  resolveShapeBindings,
  shapeBindingIssues,
  storedBindingValue,
  storedBindingValues,
  withoutBindings,
  withoutShapeBindings,
  type BindableFieldRequirement,
  type BindableFieldSpec,
  type ShapeBindingDependent,
  type ShapeBindingError,
  type ShapeBindingErrorCode,
  type ShapeBindingIssue,
  type ShapeBindingResult,
} from "./expressionBindings.js";
export {
  bindableSketchConstraint,
  boundProfileSizeFields,
  boundSketchConstraints,
  conflictingConstraintBinding,
  literalSketchProfile,
  parameterSketchConstraintDependents,
  profileSizeFields,
  rebuildableSketch,
  renameSketchConstraintReferences,
  requestedSketchProfile,
  resolveSketchConstraintBinding,
  resolveSketchConstraintBindings,
  SKETCH_CONSTRAINT_BINDABLE_KINDS,
  echoesSketchConstraints,
  sketchConstraintBindingIssues,
  sketchConstraintSummaries,
  sketchConstraintSummary,
  sketchConstraintValue,
  withSketchConstraintValues,
  type BindableSketchConstraint,
  type BindableSketchConstraintKind,
  type RequestedSketchProfile,
  type SketchConstraintBindingError,
  type SketchConstraintBindingErrorCode,
  type SketchConstraintBindingIssue,
  type SketchConstraintBindingResult,
  type SketchConstraintBindingSpec,
  type SketchConstraintSummary,
  type SketchConstraintDependent,
} from "./sketchConstraintBindings.js";
export {
  API_ERROR_CODES,
  API_ERROR_MESSAGES,
  API_PROJECT_ID_MAX_LENGTH,
  API_PROJECT_ID_PATTERN,
  apiProjectId,
  apiShapeId,
  engineFailureToApiError,
  SHAPE_CHANGE_WORDING,
  shapeChangeApiError,
  wireExpressionError,
  type ApiErrorCode,
  type ApiErrorReply,
  type ApiFailureWording,
} from "./apiErrors.js";
export {
  API_CONFIGURATION_MESSAGES,
  API_CONFIGURATION_NAME_MAX_LENGTH,
  API_PARAMETER_DIMENSIONS,
  API_PARAMETER_EXPRESSION_LIMIT,
  API_PARAMETER_EXPRESSION_MAX_LENGTH,
  API_PARAMETER_MESSAGES,
  API_PARAMETER_NAME_MAX_LENGTH,
  apiConfiguration,
  apiConfigurationList,
  apiConfigurationName,
  apiConfigurationState,
  apiConfigurationsWritten,
  apiParameter,
  apiParameterList,
  apiParameterName,
  apiParametersWritten,
  isApiConfigurationActivateRequest,
  isApiConfigurationChangeRequest,
  isApiConfigurationCreateRequest,
  isApiParameterChangeRequest,
  isApiParameterCreateRequest,
  type ApiConfigurationChange,
  type ApiParameterChange,
} from "./apiParameters.js";
export { apiShapeRequestKind, apiShapeSummary } from "./apiShapeSummary.js";
export {
  API_CONSTRAINT_ID_MAX_LENGTH,
  API_SKETCH_CONSTRAINT_MESSAGES,
  apiConstraintId,
  apiSketchConstraintBound,
  isApiSketchConstraintBindRequest,
  SKETCH_CONSTRAINT_WORDING,
  sketchConstraintApiError,
} from "./apiSketchConstraints.js";
