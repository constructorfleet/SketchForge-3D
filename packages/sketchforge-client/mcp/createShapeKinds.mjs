/**
 * What each `sketchforge_create_shape` kind turns into in each mode (issue #502).
 *
 * The tool's schema and description are built from these lists, and
 * `mcpCreateShapeKinds.test.ts` checks every claim against the local engine:
 * a kind listed as a solid must measure with a positive volume and export to
 * STL, and a kind listed as stored-only must still refuse to be measured, so a
 * kind that starts or stops building moves list rather than going unnoticed.
 */

/**
 * Every kind local mode (no url) accepts, in the tool's enum order: the engine's
 * parameter table (`REQUESTABLE_SHAPE_KINDS`) plus `revolve` and `thread`.
 */
export const LOCAL_SHAPE_KINDS = [
  "box", "cube", "cylinder", "cone", "sphere", "halfSphere", "torus",
  "tube", "ring", "polygon", "pyramid", "roof", "roundRoof", "wedge",
  "icosahedron", "text", "loft", "gear", "revolve", "thread",
];

/**
 * Kinds local mode builds as a solid: measurable, and exportable as STL.
 *
 * A `roundRoof` is here with a limit: its exact solid is half an ellipse with
 * semi-axes of half the width and the height, so a roof taller than half its
 * width fails to build. The tool description says so. A `thread` is a mesh,
 * measured from its triangles.
 */
export const LOCAL_SOLID_KINDS = [
  "box", "cube", "cylinder", "cone", "sphere", "halfSphere", "torus",
  "tube", "ring", "polygon", "pyramid", "roof", "roundRoof", "wedge",
  "loft", "revolve", "thread",
];

/**
 * Kinds local mode stores as a parameter record it cannot build: neither
 * measurable nor exportable. The server's CAD kernel has no exact builder for
 * them, so the record is only good for opening the project in an editor, which
 * draws them. Of the three, the editor bridge creates only `text`.
 */
export const LOCAL_STORED_KINDS = ["icosahedron", "text", "gear"];

/**
 * Kinds whose STEP export is exact B-Rep; every other solid exports as STL only.
 * A `revolve` is exported from the exact solid of its profile (#523); a
 * `thread` is helical, has only its tessellated sweep, and is not.
 */
export const STEP_KINDS = ["box", "cube", "cylinder", "cone", "sphere", "revolve"];

/**
 * Kinds a taper (`taperTopWidth` and the rest) builds on, in local mode only.
 * The engine's parameter table records a taper on every kind but `gear`, but
 * exact geometry exists only for these; any other tapered kind is refused when
 * it is measured or exported. The editor bridge drops taper fields entirely.
 */
export const TAPER_KINDS = ["box", "cube", "cylinder"];

/** Kinds an open editor (url) builds through the bridge. */
export const EDITOR_SHAPE_KINDS = ["box", "cube", "cylinder", "text", "loft", "sketch", "revolve", "thread"];

/** The tool's enum: every local kind plus the editor-only `sketch`. */
export const CREATE_SHAPE_KINDS = [...LOCAL_SHAPE_KINDS, "sketch"];
