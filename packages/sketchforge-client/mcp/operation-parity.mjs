/** REST route operations exposed by each MCP tool. The test joins this tool
 * inventory to the runtime REST registry and the tool declarations. */
export const MCP_RESOURCE_OPERATIONS = {
  sketchforge_list_projects: ["listProjectsOrGetProject"],
  sketchforge_create_project: ["createProject"],
  sketchforge_read_scene: ["listProjectsOrGetProject"],
  sketchforge_list_objects: ["listShapes"],
  sketchforge_delete_objects: ["deleteShape"],
  sketchforge_create_shape: ["createShapes"],
  sketchforge_import_file: ["importGeometry"],
  sketchforge_update_object: ["updateShape"],
  sketchforge_mirror_baked: ["mirrorShapes"],
  sketchforge_pattern_objects: ["patternShapes"],
  sketchforge_distribute_objects: ["distributeShapes"],
  sketchforge_align_objects: ["alignShapes"],
  sketchforge_group_objects: ["groupShapes"],
  sketchforge_ungroup_objects: ["ungroupShape"],
  sketchforge_boolean_cut: ["booleanShapes"],
  sketchforge_separate_parts: ["splitParts"],
  sketchforge_explode_step_assembly: ["explodeAssembly"],
  sketchforge_list_edges: ["listEdges"],
  sketchforge_apply_edge_treatment: ["treatShape"],
  sketchforge_list_faces: ["listFaces"],
  sketchforge_measure_shape: ["listMeasurements"],
  sketchforge_measure_between: ["measureEntities"],
  sketchforge_shape_properties: ["getShapeProperties"],
  sketchforge_estimate_wall_thickness: ["estimateThickness"],
  sketchforge_hollow_shape: ["shellShape"],
  sketchforge_check_interference: ["analyzeInterference"],
  sketchforge_export_scene: ["exportProject"],
  sketchforge_project_view: ["exportProject"],
  sketchforge_section_view: ["exportProject"],
};

/** Deliberate MCP gaps until the corresponding tools are added. */
export const MCP_UNSUPPORTED_OPERATIONS = {
  deleteProject: "The MCP server does not expose deleting a stored project; project lifecycle remains in the dashboard.",
  draftPrism: "The MCP server can create sketch shapes but does not expose the retained prism-draft operation.",
};
