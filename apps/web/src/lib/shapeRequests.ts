/**
 * Shapes described as plain data (upstream issue #55).
 *
 * The REST API and the MCP bridge both take a shape as a bag of parameters --
 * `{ kind: "cylinder", width: 20, sides: 6 }` -- and both need the same
 * answers for what a missing field means and what an out-of-range one becomes.
 * Keeping that in one pure place means a script driving the API gets the same
 * shape the editor would have built, and it can be tested without either.
 */

import {
  DEFAULT_LOFT_BOTTOM_SHAPE,
  DEFAULT_LOFT_LAYERS,
  DEFAULT_LOFT_SEGMENTS,
  DEFAULT_LOFT_TOP_SHAPE,
  normalizeLoftLayers,
  normalizeLoftRotation,
  normalizeLoftSegments,
  normalizeLoftShape,
  normalizeLoftTopSize,
} from "@/lib/loftGeometry";
import { sceneShape } from "@/lib/shapeCatalog";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export const MIN_REQUESTED_DIMENSION = 0.01;
export const MAX_REQUESTED_DIMENSION = 10_000;

/** The kinds that can be built from parameters alone, with no OCCT and no browser. */
export const REQUESTABLE_SHAPE_KINDS = ["box", "cube", "cylinder", "text", "loft"] as const;

export type RequestableShapeKind = (typeof REQUESTABLE_SHAPE_KINDS)[number];

export function isRequestableShapeKind(value: unknown): value is RequestableShapeKind {
  return typeof value === "string" && (REQUESTABLE_SHAPE_KINDS as readonly string[]).includes(value);
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function dimension(value: unknown, fallback: number) {
  const requested = finiteNumber(value, fallback);
  return Math.min(MAX_REQUESTED_DIMENSION, Math.max(MIN_REQUESTED_DIMENSION, requested));
}

function defaultColorFor(kind: RequestableShapeKind) {
  if (kind === "cylinder") return "#d97813";
  if (kind === "loft") return "#5b5ce2";
  return "#d41721";
}

function defaultNameFor(kind: RequestableShapeKind) {
  if (kind === "cylinder") return "Cylinder";
  if (kind === "loft") return "Loft";
  if (kind === "text") return "Text";
  return kind === "cube" ? "Cube" : "Box";
}

export type ShapeRequest = Record<string, unknown>;

/**
 * The dimensions a request asks for.
 *
 * `size` stands in for any of the three, and a cube takes its width for all of
 * them, so `{ kind: "cube", size: 10 }` and `{ kind: "cube", width: 10 }` mean
 * the same thing.
 */
export function requestedDimensions(request: ShapeRequest) {
  const width = dimension(request.width ?? request.size, 20);
  const isCube = request.kind === "cube";
  return {
    width,
    depth: dimension(request.depth ?? request.size, isCube ? width : 20),
    height: dimension(request.height ?? request.size, isCube ? width : 20),
  };
}

/**
 * A shape built from a request, or null when the kind cannot be built this way.
 *
 * Sketch extrusions are the notable absence: their geometry comes from OCCT,
 * which only runs in the editor's worker.
 */
export function shapeFromRequest(request: ShapeRequest, defaults: { elevation?: number } = {}): WorkplaneShape | null {
  const requestedKind = nonEmptyString(request.kind, "box");
  if (!isRequestableShapeKind(requestedKind)) return null;
  // "cube" is a box whose sides match; it is not a kind of its own.
  const kind = requestedKind === "cube" ? "box" : requestedKind;
  const { width, depth, height } = requestedDimensions({ ...request, kind: requestedKind });

  const base = {
    name: nonEmptyString(request.name, defaultNameFor(requestedKind)),
    kind,
    color: nonEmptyString(request.color, defaultColorFor(requestedKind)),
    x: finiteNumber(request.x, 0),
    z: finiteNumber(request.z, 0),
    elevation: finiteNumber(request.elevation, defaults.elevation ?? 0),
    width,
    depth,
    height,
    size: Math.max(width, depth),
    rotation: finiteNumber(request.rotation, 0),
    rotationX: finiteNumber(request.rotationX, 0),
    rotationZ: finiteNumber(request.rotationZ, 0),
    hole: request.hole === true,
  } as const;

  if (kind === "cylinder") {
    return canonicalizeShape(sceneShape({
      ...base,
      sides: Math.max(3, Math.floor(finiteNumber(request.sides, 96))),
    }));
  }

  if (kind === "text") {
    return canonicalizeShape(sceneShape({
      ...base,
      text: nonEmptyString(request.text, "TEXT"),
      font: nonEmptyString(request.font, "Multilanguage"),
      bevel: Math.max(0, finiteNumber(request.bevel, 0)),
      segments: Math.max(1, Math.floor(finiteNumber(request.segments, 2))),
    }));
  }

  if (kind === "loft") {
    return canonicalizeShape(sceneShape({
      ...base,
      loftBottomShape: normalizeLoftShape(nonEmptyString(request.loftBottomShape, DEFAULT_LOFT_BOTTOM_SHAPE), DEFAULT_LOFT_BOTTOM_SHAPE),
      loftTopShape: normalizeLoftShape(nonEmptyString(request.loftTopShape, DEFAULT_LOFT_TOP_SHAPE), DEFAULT_LOFT_TOP_SHAPE),
      loftTopWidth: normalizeLoftTopSize(finiteNumber(request.loftTopWidth, width), width),
      loftTopDepth: normalizeLoftTopSize(finiteNumber(request.loftTopDepth, depth), depth),
      loftBottomRotation: normalizeLoftRotation(finiteNumber(request.loftBottomRotation, 0)),
      loftTopRotation: normalizeLoftRotation(finiteNumber(request.loftTopRotation, 0)),
      loftSegments: normalizeLoftSegments(finiteNumber(request.loftSegments, DEFAULT_LOFT_SEGMENTS)),
      loftLayers: normalizeLoftLayers(finiteNumber(request.loftLayers, DEFAULT_LOFT_LAYERS)),
    }));
  }

  return canonicalizeShape(sceneShape(base));
}

/** The fields a request may change on an existing shape, applied in place of a rebuild. */
export function shapeWithRequestedChanges(shape: WorkplaneShape, request: ShapeRequest): WorkplaneShape {
  const next: WorkplaneShape = { ...shape };
  if (request.name !== undefined) next.name = nonEmptyString(request.name, shape.name);
  if (request.color !== undefined) next.color = nonEmptyString(request.color, shape.color);
  if (request.x !== undefined) next.x = finiteNumber(request.x, shape.x);
  if (request.z !== undefined) next.z = finiteNumber(request.z, shape.z);
  if (request.elevation !== undefined) next.elevation = finiteNumber(request.elevation, shape.elevation ?? 0);
  if (request.width !== undefined) next.width = dimension(request.width, shape.width ?? 20);
  if (request.depth !== undefined) next.depth = dimension(request.depth, shape.depth ?? 20);
  if (request.height !== undefined) next.height = dimension(request.height, shape.height);
  if (request.rotation !== undefined) next.rotation = finiteNumber(request.rotation, shape.rotation);
  if (request.rotationX !== undefined) next.rotationX = finiteNumber(request.rotationX, shape.rotationX ?? 0);
  if (request.rotationZ !== undefined) next.rotationZ = finiteNumber(request.rotationZ, shape.rotationZ ?? 0);
  if (request.hole !== undefined) next.hole = request.hole === true;
  if (request.locked !== undefined) next.locked = request.locked === true;
  if (request.hidden !== undefined) next.hidden = request.hidden === true;
  if (next.width !== shape.width || next.depth !== shape.depth) {
    next.size = Math.max(next.width ?? 20, next.depth ?? 20);
  }
  return canonicalizeShape(next);
}
