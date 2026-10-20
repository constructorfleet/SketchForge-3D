export { SketchForgeClient, ProjectHandle, type SketchForgeClientOptions } from "./client.js";
export { SketchForgeApiError, SketchForgeTransportError, type ApiErrorContext } from "./errors.js";
export { Transport, normalizeBaseUrl, buildUrl, type FetchLike, type RequestSpec, type TransportOptions } from "./http.js";
export { Projects } from "./resources/projects.js";
export { Shapes, chunk } from "./resources/shapes.js";
export { Edges } from "./resources/edges.js";
export { Treatments } from "./resources/treatments.js";
export {
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  MissingConfigurationError,
  PROJECT_ENV,
  TOKEN_ENV,
  clientFromEnvironment,
  targetProjectFromEnvironment,
  type Environment,
} from "./environment.js";
export {
  defineMacro,
  macroFromModule,
  macroLayout,
  resolveMacroParams,
  resolveMacroProject,
  runMacro,
  runStamp,
  type MacroContext,
  type MacroDefinition,
  type MacroLayout,
  type MacroParameterValue,
  type MacroProjectMode,
  type MacroProjectSpec,
  type MacroRunReport,
  type ResolvedMacroProject,
} from "./macro.js";
export { centeredOffsets, grid, mm, ring, row, type Point2 } from "./layout.js";
export * from "./types.js";
