import { describe, expect, it, vi } from "vitest";
import { appendEditorHistorySnapshot, editorHistoryEntry } from "@/lib/engine/editorHistory";
import { createKeyboardMovementInteraction, moveShapesByKeyboard, type KeyboardMovementEvent } from "@/lib/keyboardMovement";
import { horizontalPlacementWorkplane, type PlacementWorkplane } from "@/lib/engine/placementWorkplane";
import { keyboardNudgeStep } from "@/lib/engine/workplaneSettings";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(id = "box", locked = false): WorkplaneShape {
  return { id, name: id, kind: "box", color: "#123456", x: 0, z: 0, elevation: 0,
    size: 20, width: 20, depth: 20, height: 20, rotation: 0, locked };
}

function key(key: string, overrides: Partial<KeyboardMovementEvent> = {}): KeyboardMovementEvent {
  return { key, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides };
}

function editorHarness(initial = [box()], selectedIds = ["box"]) {
  let shapes = initial;
  let history = [editorHistoryEntry(shapes, selectedIds)];
  let index = 0;
  let busy = false;
  const save = vi.fn();
  const begin = vi.fn(() => {
    if (busy || !shapes.some((shape) => selectedIds.includes(shape.id) && !shape.locked)) return false;
    busy = true;
    return true;
  });
  const movement = createKeyboardMovementInteraction({
    begin,
    move: (event) => { shapes = moveShapesByKeyboard(shapes, selectedIds, event, horizontalPlacementWorkplane(), keyboardNudgeStep("1.0 mm", event.shiftKey)); },
    end: () => {
      busy = false;
      const appended = appendEditorHistorySnapshot(history, index, editorHistoryEntry(shapes, selectedIds));
      history = appended.entries;
      index = appended.index;
      if (appended.changed) save(shapes);
    },
  });
  return {
    movement, save, begin,
    get shapes() { return shapes; },
    get history() { return history; },
    setBusy() { busy = true; },
    undo() { shapes = history[--index].shapes; },
    redo() { shapes = history[++index].shapes; },
  };
}

describe("keyboard movement interactions", () => {
  it.each([
    ["ArrowRight", {}, "x", 31],
    ["ArrowLeft", {}, "x", -31],
    ["ArrowUp", {}, "z", -31],
    ["ArrowDown", {}, "z", 31],
    ["ArrowUp", { ctrlKey: true }, "elevation", 31],
    ["ArrowDown", { metaKey: true, shiftKey: true }, "elevation", -155],
  ] as const)("batches a held %s into one undo step and save", (name, modifiers, coordinate, expected) => {
    const editor = editorHarness();
    editor.movement.keyDown(key(name, modifiers));
    for (let repeat = 0; repeat < 30; repeat++) editor.movement.keyDown(key(name, { ...modifiers, repeat: true }));
    expect(editor.shapes[0][coordinate]).toBe(expected);
    expect(editor.history).toHaveLength(1);
    expect(editor.save).not.toHaveBeenCalled();
    expect(editor.begin).toHaveBeenCalledTimes(1);

    editor.movement.keyUp(name);
    expect(editor.history).toHaveLength(2);
    expect(editor.save).toHaveBeenCalledTimes(1);
    editor.undo();
    expect(editor.shapes[0][coordinate]).toBe(0);
    editor.redo();
    expect(editor.shapes[0][coordinate]).toBe(expected);
  });

  it("keeps rapid discrete taps as separate undo steps", () => {
    const editor = editorHarness();
    for (let tap = 0; tap < 3; tap++) {
      editor.movement.keyDown(key("ArrowRight"));
      editor.movement.keyUp("ArrowRight");
    }
    expect(editor.history).toHaveLength(4);
    expect(editor.save).toHaveBeenCalledTimes(3);
    editor.undo();
    expect(editor.shapes[0].x).toBe(2);
    editor.undo();
    expect(editor.shapes[0].x).toBe(1);
  });

  it("ends overlapping movement keys only when the last arrow is released", () => {
    const editor = editorHarness();
    editor.movement.keyDown(key("ArrowRight"));
    editor.movement.keyDown(key("ArrowUp"));
    editor.movement.keyUp("ArrowRight");
    editor.movement.keyUp("Control");
    expect(editor.save).not.toHaveBeenCalled();
    editor.movement.keyDown(key("ArrowUp", { repeat: true, ctrlKey: true }));
    editor.movement.keyUp("ArrowUp");
    expect(editor.shapes[0]).toMatchObject({ x: 1, z: -1, elevation: 1 });
    expect(editor.save).toHaveBeenCalledTimes(1);
  });

  it("finishes interrupted holds once and ignores stale repeats until a fresh press", () => {
    const editor = editorHarness();
    editor.movement.keyDown(key("ArrowRight"));
    editor.movement.finish(); // Focus loss, another command, navigation, or pointer input.
    editor.movement.finish();
    editor.movement.keyUp("ArrowRight");
    expect(editor.movement.keyDown(key("ArrowRight", { repeat: true }))).toBe(false);
    expect(editor.save).toHaveBeenCalledTimes(1);
    expect(editor.shapes[0].x).toBe(1);
    editor.movement.keyDown(key("ArrowRight"));
    editor.movement.keyUp("ArrowRight");
    expect(editor.shapes[0].x).toBe(2);
    expect(editor.save).toHaveBeenCalledTimes(2);
  });

  it("does not create an entry for a hold that returns to its starting position", () => {
    const editor = editorHarness();
    editor.movement.keyDown(key("ArrowRight"));
    editor.movement.keyDown(key("ArrowLeft"));
    editor.movement.keyUp("ArrowRight");
    editor.movement.keyUp("ArrowLeft");
    expect(editor.history).toHaveLength(1);
    expect(editor.save).not.toHaveBeenCalled();
  });

  it("respects locked objects, empty selections, and an active pointer transform", () => {
    for (const editor of [editorHarness([box("box", true)]), editorHarness([box()], [])]) {
      expect(editor.movement.keyDown(key("ArrowRight"))).toBe(false);
      editor.movement.keyUp("ArrowRight");
      expect(editor.history).toHaveLength(1);
      expect(editor.save).not.toHaveBeenCalled();
    }
    const editor = editorHarness();
    editor.setBusy();
    expect(editor.movement.keyDown(key("ArrowRight"))).toBe(false);
    editor.movement.finish();
    expect(editor.save).not.toHaveBeenCalled();
  });

  it("moves only unlocked selected objects along the active workplane axes", () => {
    const shapes = [box(), box("locked", true), box("other")];
    const plane: PlacementWorkplane = {
      origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 },
    };
    const nudged = moveShapesByKeyboard(shapes, ["box", "locked"], key("ArrowRight", { shiftKey: true }), plane, keyboardNudgeStep("1.0 mm", true));
    expect(nudged[0]).toMatchObject({ x: 0, z: 0, elevation: 5 });
    expect(nudged[1]).toBe(shapes[1]);
    expect(nudged[2]).toBe(shapes[2]);
    const raised = moveShapesByKeyboard(nudged, ["box"], key("ArrowUp", { ctrlKey: true }), plane, keyboardNudgeStep("1.0 mm", false));
    expect(raised[0]).toMatchObject({ x: 0, z: 1, elevation: 5 });
  });
});

describe("moveShapesByKeyboard follows the camera", () => {
  const plane = horizontalPlacementWorkplane();
  const step = keyboardNudgeStep("1.0 mm", false);
  // Pitched above the horizon, like every default view.
  const view = (yawDegrees: number) => ({ yawDegrees, pitchDegrees: 35 });

  function moved(arrow: string, camera?: { yawDegrees: number; pitchDegrees: number }) {
    const result = moveShapesByKeyboard([box()], ["box"], key(arrow), plane, step, camera);
    return { x: result[0].x, z: result[0].z, elevation: result[0].elevation };
  }

  it("keeps the Front view mapping when no camera is supplied", () => {
    // The fixed mapping these keys had before they followed the view.
    expect(moved("ArrowRight")).toMatchObject({ x: 1, z: 0 });
    expect(moved("ArrowLeft")).toMatchObject({ x: -1, z: 0 });
    expect(moved("ArrowDown")).toMatchObject({ x: 0, z: 1 });
    expect(moved("ArrowUp")).toMatchObject({ x: 0, z: -1 });
  });

  it("leaves the default home view on the axes it always used", () => {
    // Home sits at yaw 45, exactly between two axes, and the tie rounds to the
    // axis the editor already used -- so a user who never orbits sees no change.
    for (const arrow of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(moved(arrow, view(45))).toEqual(moved(arrow));
    }
  });

  it("sends an arrow towards the axis it points at on screen once orbited", () => {
    // Orbited a quarter turn, Right must no longer be +X: that is the reported
    // bug, where the shape walked into the screen instead of to the right.
    expect(moved("ArrowRight", view(90))).toMatchObject({ x: 0, z: -1 });
    expect(moved("ArrowLeft", view(90))).toMatchObject({ x: 0, z: 1 });
    expect(moved("ArrowRight", view(180))).toMatchObject({ x: -1, z: 0 });
    expect(moved("ArrowRight", view(270))).toMatchObject({ x: 0, z: 1 });
  });

  it("never steps diagonally, whatever the yaw", () => {
    for (let yaw = -360; yaw <= 360; yaw += 7) {
      for (const arrow of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        const result = moved(arrow, view(yaw));
        const movedAxes = [result.x, result.z].filter((value) => value !== 0);
        expect(movedAxes, `yaw ${yaw} ${arrow}`).toHaveLength(1);
        expect(Math.abs(movedAxes[0])).toBeCloseTo(step, 10);
      }
    }
  });

  it("mirrors screen down when the camera is below the horizon", () => {
    const above = moved("ArrowDown", { yawDegrees: 0, pitchDegrees: 20 });
    const below = moved("ArrowDown", { yawDegrees: 0, pitchDegrees: -20 });
    expect(below).toMatchObject({ x: 0, z: -above.z! });
  });

  it("keeps elevation changes off the camera entirely", () => {
    // Ctrl/Cmd + Up/Down moves along the plane normal, which is not a screen
    // direction, so no view may turn it into a horizontal move.
    for (const yaw of [0, 45, 90, 180, 270]) {
      const result = moveShapesByKeyboard([box()], ["box"], key("ArrowUp", { ctrlKey: true }), plane, step, view(yaw));
      expect(result[0]).toMatchObject({ x: 0, z: 0, elevation: 1 });
    }
  });

  it("leaves a workplane laid on a face on its own axes", () => {
    // Following the camera there would walk the selection off the face.
    const onFace: PlacementWorkplane = {
      origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 },
    };
    for (const yaw of [0, 90, 180, 270]) {
      const result = moveShapesByKeyboard([box()], ["box"], key("ArrowRight"), onFace, step, view(yaw));
      expect(result[0]).toMatchObject({ x: 0, z: 0, elevation: 1 });
    }
  });
});
