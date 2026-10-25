export type EditorMeasurementEnd = {
  shapeId: string;
  entity?: "shape" | "edge" | "face";
  index?: number;
};

export type EditorSection = { plane: "xy" | "xz" | "yz"; offset: number };

export function editorMeasureRequest(
  projectId: string,
  from: object,
  to: object,
  fromEntity: EditorMeasurementEnd["entity"] = "shape",
  fromIndex?: number,
  toEntity: EditorMeasurementEnd["entity"] = "shape",
  toIndex?: number,
) {
  return {
    url: "/api/editor/cad",
    body: {
      operation: "measure",
      projectId,
      from: { shape: from, entity: fromEntity, ...(fromIndex === undefined ? {} : { index: fromIndex }) },
      to: { shape: to, entity: toEntity, ...(toIndex === undefined ? {} : { index: toIndex }) },
    },
  };
}

export function editorPropertiesRequest(projectId: string, shape: object) {
  return { url: "/api/editor/cad", body: { operation: "properties", projectId, shape } };
}

export function editorExportRequest(
  projectId: string,
  format: "svg" | "dxf",
  name: string,
  section?: EditorSection,
  shapes?: object[],
) {
  return {
    url: "/api/editor/cad",
    body: { operation: "export", projectId, format, name, ...(section ? { section } : {}), ...(shapes?.length ? { shapes } : {}) },
  };
}
