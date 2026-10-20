/**
 * The client, and the project handle a macro actually works through.
 *
 * Resources are plain objects hanging off the client, each owning one route.
 * A route added to the API later is a new file here and one more field; nothing
 * in the transport or the handle needs to know about it.
 */

import { SketchForgeApiError, SketchForgeTransportError } from "./errors.js";
import { Transport, type TransportOptions } from "./http.js";
import { Edges } from "./resources/edges.js";
import { Faces } from "./resources/faces.js";
import { Measurements } from "./resources/measurements.js";
import { Projects } from "./resources/projects.js";
import { Shapes } from "./resources/shapes.js";
import { Shell } from "./resources/shell.js";
import { Treatments } from "./resources/treatments.js";
import type {
  EdgeSummary,
  EdgeTreatment,
  FaceDirection,
  FaceSummary,
  MeasurementEnd,
  MeasurementPair,
  MeasurementSummary,
  ProjectDetail,
  ShapePatch,
  ShapeRequest,
  ShapeSummary,
  ShapeWriteResult,
  ShellRequest,
  ShellResult,
  TreatmentResult,
} from "./types.js";

export type SketchForgeClientOptions = TransportOptions;

export class SketchForgeClient {
  readonly projects: Projects;
  readonly shapes: Shapes;
  readonly edges: Edges;
  readonly faces: Faces;
  readonly measurements: Measurements;
  readonly treatments: Treatments;
  readonly shell: Shell;
  private readonly transport: Transport;

  constructor(options: SketchForgeClientOptions) {
    this.transport = new Transport(options);
    this.projects = new Projects(this.transport);
    this.shapes = new Shapes(this.transport);
    this.edges = new Edges(this.transport);
    this.faces = new Faces(this.transport);
    this.measurements = new Measurements(this.transport);
    this.treatments = new Treatments(this.transport);
    this.shell = new Shell(this.transport);
  }

  get apiRoot() {
    return this.transport.apiRoot;
  }

  /** A view of one project, so a macro does not thread its id through every call. */
  project(projectId: string) {
    return new ProjectHandle(this, projectId);
  }

  /**
   * Whether the API is reachable, enabled, and has storage.
   *
   * Worth calling first in anything interactive: the three ways this fails --
   * no token on the server, no project directory, wrong port -- are answered by
   * a 404, a 503 and a connection error, none of which reads as a
   * configuration mistake on its own.
   */
  async check(): Promise<{ ok: true; projects: number } | { ok: false; reason: string }> {
    try {
      const projects = await this.projects.list();
      return { ok: true, projects: projects.length };
    } catch (error) {
      if (error instanceof SketchForgeApiError) {
        if (error.looksDisabled) return { ok: false, reason: "The server has no SKETCHFORGE_API_TOKEN set, so the API is off." };
        if (error.needsStorage) return { ok: false, reason: "The server has no SKETCHFORGE_PROJECTS_DIR set, so it can store nothing." };
        if (error.status === 401) return { ok: false, reason: "The token was refused." };
        return { ok: false, reason: error.message };
      }
      if (error instanceof SketchForgeTransportError) return { ok: false, reason: error.message };
      throw error;
    }
  }
}

export class ProjectHandle {
  constructor(
    private readonly client: SketchForgeClient,
    readonly id: string,
  ) {}

  get(): Promise<ProjectDetail> {
    return this.client.projects.get(this.id);
  }

  delete() {
    return this.client.projects.delete(this.id);
  }

  listShapes(): Promise<ShapeSummary[]> {
    return this.client.shapes.list(this.id);
  }

  add(shape: ShapeRequest): Promise<ShapeSummary> {
    return this.client.shapes.create(this.id, shape);
  }

  addMany(shapes: readonly ShapeRequest[]): Promise<ShapeWriteResult> {
    return this.client.shapes.createMany(this.id, shapes);
  }

  update(shapeId: string, changes: ShapePatch) {
    return this.client.shapes.update(this.id, shapeId, changes);
  }

  remove(shapeId: string) {
    return this.client.shapes.delete(this.id, shapeId);
  }

  clear(): Promise<number> {
    return this.client.shapes.deleteAll(this.id);
  }

  edges(shapeId: string): Promise<EdgeSummary[]> {
    return this.client.edges.list(this.id, shapeId);
  }

  filletableEdges(shapeId: string): Promise<number[]> {
    return this.client.edges.filletableIndexes(this.id, shapeId);
  }

  treat(shapeId: string, treatment: EdgeTreatment): Promise<TreatmentResult> {
    return this.client.treatments.apply(this.id, shapeId, treatment);
  }

  fillet(shapeId: string, radius: number, edges?: readonly number[]) {
    return this.client.treatments.fillet(this.id, shapeId, radius, edges);
  }

  chamfer(shapeId: string, distance: number, options?: { angle?: number; edges?: readonly number[] }) {
    return this.client.treatments.chamfer(this.id, shapeId, distance, options);
  }

  faces(shapeId: string): Promise<FaceSummary[]> {
    return this.client.faces.list(this.id, shapeId);
  }

  facesFacing(shapeId: string, direction: FaceDirection): Promise<number[]> {
    return this.client.faces.facing(this.id, shapeId, direction);
  }

  measurements(shapeId: string): Promise<MeasurementSummary[]> {
    return this.client.measurements.list(this.id, shapeId);
  }

  measurementsWithRadius(shapeId: string): Promise<MeasurementSummary[]> {
    return this.client.measurements.withRadius(this.id, shapeId);
  }

  /** The distance between two entities, which may be on two different shapes. */
  measureBetween(from: MeasurementEnd, to: MeasurementEnd): Promise<MeasurementPair> {
    return this.client.measurements.between(this.id, from, to);
  }

  /** Hollows the shape out, sealed unless `openFaces` names faces to leave off. */
  shell(shapeId: string, request: ShellRequest): Promise<ShellResult> {
    return this.client.shell.apply(this.id, shapeId, request);
  }

  hollow(shapeId: string, thickness: number) {
    return this.client.shell.hollow(this.id, shapeId, thickness);
  }

  tray(shapeId: string, thickness: number, openFaces?: ShellRequest["openFaces"]) {
    return this.client.shell.tray(this.id, shapeId, thickness, openFaces);
  }
}
