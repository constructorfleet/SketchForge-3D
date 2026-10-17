import type { ShapeKind, WorkplaneShape } from "@/types/sketchforge";

export type SceneRow = {
  id: string;
  /** Name as stored; the view translates default names for display. */
  name: string;
  kind: ShapeKind;
  color: string;
  /** Nesting level: 0 for a shape in the scene, deeper for a group's members. */
  depth: number;
  hidden: boolean;
  locked: boolean;
  hole: boolean;
  /** How many shapes this one groups, 0 when it is not a group. */
  childCount: number;
  /**
   * Whether the row can be selected, hidden or deleted.
   *
   * Only shapes in the scene can. A group's members are shown so the contents
   * are visible at a glance, but the editor has no notion of selecting one
   * without ungrouping first, so their rows stay informational rather than
   * offering controls that cannot work.
   */
  actionable: boolean;
};

export type SceneTreeOptions = {
  /** Ids of groups whose members are shown. */
  expandedIds?: ReadonlySet<string>;
  /** Hide rows whose name does not match, case-insensitively. */
  filter?: string;
};

function matches(shape: WorkplaneShape, needle: string) {
  return shape.name.toLowerCase().includes(needle) || shape.kind.toLowerCase().includes(needle);
}

/**
 * The scene as a flat list of rows, deepest-last, ready to render.
 *
 * Flat rather than nested so the list can be keyboard-navigated and virtualised
 * later without restructuring; `depth` carries the indentation.
 *
 * Newest shapes come first: the thing just added is the thing being looked for,
 * and it is the opposite of the scene order, where the newest is drawn last.
 */
export function sceneRows(shapes: readonly WorkplaneShape[], options: SceneTreeOptions = {}): SceneRow[] {
  const expanded = options.expandedIds ?? new Set<string>();
  const needle = options.filter?.trim().toLowerCase() ?? "";
  const rows: SceneRow[] = [];

  const pushRow = (shape: WorkplaneShape, depth: number) => {
    const children = shape.groupedShapes ?? [];
    rows.push({
      id: shape.id,
      name: shape.name,
      kind: shape.kind,
      color: shape.color,
      depth,
      hidden: Boolean(shape.hidden),
      locked: Boolean(shape.locked),
      hole: Boolean(shape.hole),
      childCount: children.length,
      actionable: depth === 0,
    });
    if (children.length > 0 && expanded.has(shape.id)) {
      // A group's members keep their own order: it is the order they were
      // combined in, and renumbering them would not match anything on screen.
      children.forEach((child) => pushRow(child, depth + 1));
    }
  };

  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index];
    // A filter matches a group when any member matches, so a group is never
    // hidden while something inside it is what was searched for.
    const children = shape.groupedShapes ?? [];
    if (needle && !matches(shape, needle) && !children.some((child) => matches(child, needle))) {
      continue;
    }
    pushRow(shape, 0);
  }
  return rows;
}

export type SceneSummary = {
  total: number;
  hidden: number;
  locked: number;
  holes: number;
  groups: number;
};

/** Counts for the panel header; scene shapes only, not group members. */
export function sceneSummary(shapes: readonly WorkplaneShape[]): SceneSummary {
  return {
    total: shapes.length,
    hidden: shapes.filter((shape) => shape.hidden).length,
    locked: shapes.filter((shape) => shape.locked).length,
    holes: shapes.filter((shape) => shape.hole).length,
    groups: shapes.filter((shape) => (shape.groupedShapes?.length ?? 0) > 0).length,
  };
}

/**
 * Selection after clicking a row.
 *
 * Plain click replaces the selection; a modifier adds or removes, matching the
 * canvas. Clicking the only selected shape again clears it, so the list can
 * deselect without reaching for the canvas.
 */
export function selectionAfterRowClick(
  current: readonly string[],
  id: string,
  additive: boolean,
): string[] {
  if (additive) {
    return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
  }
  if (current.length === 1 && current[0] === id) {
    return [];
  }
  return [id];
}
