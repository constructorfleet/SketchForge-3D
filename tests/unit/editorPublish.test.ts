import { describe, expect, it } from "vitest";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine";
import { NO_CONFIGURATIONS, type ProjectConfigurationState } from "@/lib/engine/editorHistory";
import { classifyHostProps, createEditorPublisher, type PublishScheduler } from "@/lib/editorPublish";
import type { ProjectParameter, WorkplaneShape } from "@/types/sketchforge";

/** Runs timers only when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const scheduler: PublishScheduler = {
    set: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { scheduler, advance, pending: () => timers.size };
}

function box(id: string, width = 10): WorkplaneShape {
  const shape = shapeFromRequest({ kind: "box", width, depth: 10, height: 10 });
  if (!shape) throw new Error("no box");
  return { ...shape, id, name: id };
}

const wall: ProjectParameter = { name: "wall", expression: "2", dimension: "length", value: 2 } as ProjectParameter;

/** One editor's publisher, with the host's sends recorded. */
function editor({ table = [] as ProjectParameter[] } = {}) {
  const clock = fakeClock();
  const sent: { projectId: string; shapes: string[]; table: string[] }[] = [];
  /** The shapes of each send, in full. */
  const sentScenes: WorkplaneShape[][] = [];
  const local = { shapes: [] as WorkplaneShape[], parameters: table, configuration: NO_CONFIGURATIONS as ProjectConfigurationState };
  const publisher = createEditorPublisher({
    scheduler: clock.scheduler,
    initialTable: { parameters: table, configuration: NO_CONFIGURATIONS },
    host: {
      enabled: () => true,
      table: () => ({ parameters: local.parameters, configuration: local.configuration }),
      currentShapes: () => local.shapes,
      send: (projectId, shapes) => sentScenes.push(shapes) && sent.push({ projectId, shapes: shapes.map((shape) => shape.id), table: local.parameters.map((parameter) => parameter.name) }),
    },
  });
  /** Opens `projectId` with the host's copy, as the component does on a new project. */
  const open = (projectId: string, shapes: WorkplaneShape[], parameters = local.parameters) => {
    publisher.projectChanged(projectId);
    const decision = props(projectId, shapes, parameters);
    expect(decision.action).toBe("hydrate");
    if (decision.action === "hydrate") local.shapes = decision.shapes;
    publisher.shapesRendered(local.shapes);
    return decision;
  };
  const props = (projectId: string | null, shapes: WorkplaneShape[], parameters: ProjectParameter[] = local.parameters) =>
    publisher.hostProps({ projectId, shapes, parameters, configuration: NO_CONFIGURATIONS, currentShapes: local.shapes });
  /** A local edit as the component makes it: state set, then the rendered shapes forwarded. */
  const edit = (shapes: WorkplaneShape[]) => {
    local.shapes = shapes;
    publisher.shapesRendered(shapes);
  };
  return { publisher, clock, sent, sentScenes, local, open, props, edit };
}

describe("editor publish module", () => {
  it("publishes a local edit under its project 120 ms after it is made", () => {
    const { clock, sent, open, edit } = editor();
    open("a", []);
    edit([box("box")]);
    clock.advance(119);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toEqual([{ projectId: "a", shapes: ["box"], table: [] }]);
  });

  it("does not publish the render of a hydrate, nor an edit the host already has", () => {
    const { publisher, clock, sent, open, local } = editor();
    open("a", [box("one")]);
    publisher.localEdit(local.shapes);
    clock.advance(500);
    expect(sent).toEqual([]);
    expect(publisher.isHydrating()).toBe(false);
  });

  it("keeps an unpublished edit when the host re-renders the scene it already had (#657)", () => {
    const { clock, sent, open, edit, props } = editor();
    open("a", []);
    edit([box("box")]);
    clock.advance(50);
    // The switch to server storage re-renders with the empty scene inside the gap.
    expect(props("a", []).action).toBe("echo");
    clock.advance(70);
    expect(sent).toEqual([{ projectId: "a", shapes: ["box"], table: [] }]);
  });

  it("keeps a forced table-only publish through a re-render with the same table and shapes (#663, #664)", () => {
    const { publisher, clock, sent, open, props, local } = editor({ table: [wall] });
    const scene = [box("box")];
    open("a", scene);
    // Undo removes the parameter; the shapes do not change, so the publish is forced.
    local.parameters = [];
    publisher.localEdit(local.shapes, { force: true });
    const decision = props("a", scene, [wall]);
    expect(decision).toMatchObject({ action: "unchanged", adoptTable: false });
    clock.advance(120);
    expect(sent).toEqual([{ projectId: "a", shapes: ["box"], table: [] }]);
  });

  it("publishes a pending forced table-only undo before a drag starts (#688)", () => {
    const { publisher, clock, sent, sentScenes, open, edit, local } = editor({ table: [wall] });
    open("a", [box("box")]);
    local.parameters = [];
    publisher.localEdit(local.shapes, { force: true });
    publisher.interactionStarted();
    expect(sent).toEqual([{ projectId: "a", shapes: ["box"], table: [] }]);

    edit([box("box", 20)]);
    publisher.interactionEnded();
    clock.advance(180 + 120);
    expect(sent.map((entry) => entry.shapes)).toEqual([["box"], ["box"]]);
    expect(sentScenes.map((scene) => scene[0]!.width)).toEqual([10, 20]);
  });

  it("tells its own echo from a real host change, which replaces the pending publish", () => {
    const { clock, sent, open, edit, props } = editor();
    open("a", []);
    edit([box("mine")]);
    clock.advance(120);
    expect(props("a", [box("mine")]).action).toBe("echo");
    edit([box("mine"), box("next")]);
    const remote = props("a", [box("theirs")]);
    expect(remote.action).toBe("hydrate");
    if (remote.action === "hydrate") expect(remote.shapes.map((shape) => shape.id)).toEqual(["theirs"]);
    clock.advance(500);
    expect(sent).toHaveLength(1);
  });

  it("adopts a remote table change as a hydrate even when the shapes are unchanged", () => {
    const { open, props } = editor();
    const scene = [box("box")];
    open("a", scene);
    expect(props("a", scene, [wall])).toMatchObject({ action: "hydrate", adoptTable: true, projectChanged: false });
  });

  it("drops the pending publish on projectChanged(null), as a delete, conflict or load failure closes the project (#665)", () => {
    const { publisher, clock, sent, open, edit, props } = editor();
    open("a", []);
    edit([box("box")]);
    publisher.projectChanged(null);
    expect(props(null, []).action).toBe("ignored");
    clock.advance(500);
    expect(sent).toEqual([]);
    edit([box("later")]);
    clock.advance(500);
    expect(sent).toEqual([]);
  });

  it("sends the pending publish under the old project before another loaded project hydrates (#668)", () => {
    const { publisher, clock, sent, open, edit, props } = editor();
    open("a", [box("first")]);
    edit([box("first"), box("second")]);
    publisher.projectChanged("b");
    expect(sent).toEqual([{ projectId: "a", shapes: ["first", "second"], table: [] }]);
    expect(props("b", [])).toMatchObject({ action: "hydrate", projectChanged: true });
    clock.advance(500);
    expect(sent).toHaveLength(1);
  });

  it("sends the pending publish when the editor unmounts to load a project not loaded yet (#668)", () => {
    const { publisher, clock, sent, open, edit } = editor();
    open("a", [box("first")]);
    edit([box("first"), box("second")]);
    publisher.unmount();
    expect(sent).toEqual([{ projectId: "a", shapes: ["first", "second"], table: [] }]);
    clock.advance(500);
    expect(sent).toHaveLength(1);
  });

  it("holds edits during an interaction and publishes the scene 180 ms after it ends", () => {
    const { publisher, clock, sent, sentScenes, open, edit, props } = editor();
    open("a", []);
    edit([box("box")]);
    publisher.interactionStarted();
    clock.advance(500);
    expect(sent).toEqual([]);
    edit([box("box", 20)]);
    expect(props("a", [box("theirs")]).action).toBe("ignored");
    publisher.interactionEnded();
    clock.advance(179);
    expect(sent).toEqual([]);
    clock.advance(1 + 120);
    expect(sent).toEqual([{ projectId: "a", shapes: ["box"], table: [] }]);
    expect(sentScenes[0]!.map((shape) => shape.width)).toEqual([20]);
  });

  it("sends a publish that was pending when a drag started, even when the drag moves nothing", () => {
    const { publisher, clock, sentScenes, open, edit } = editor();
    open("a", []);
    edit([box("box", 30)]);
    clock.advance(50);
    publisher.interactionStarted();
    publisher.interactionEnded();
    clock.advance(180 + 120);
    expect(sentScenes.map((scene) => scene.map((shape) => shape.width))).toEqual([[30]]);
  });

  it("takes back the table it sent as its own, so the next pending publish survives", () => {
    const { publisher, clock, sent, open, edit, props, local } = editor();
    const scene = [box("box")];
    open("a", scene);
    local.parameters = [wall];
    publisher.localEdit(local.shapes, { force: true });
    clock.advance(120);
    edit([box("box"), box("next")]);
    // The host passes back the table and shapes it was sent, before the next edit publishes.
    expect(props("a", scene, [wall])).toMatchObject({ action: "echo", adoptTable: false });
    clock.advance(120);
    expect(sent.map((entry) => entry.shapes)).toEqual([["box"], ["box", "next"]]);
  });

  it("forgets the last project's echo when the host moves to another project", () => {
    const { publisher, clock, open, edit, props, local } = editor();
    open("a", []);
    edit([box("shared")]);
    clock.advance(120);
    publisher.projectChanged("b");
    expect(props("b", [])).toMatchObject({ action: "hydrate", projectChanged: true });
    local.shapes = [];
    publisher.shapesRendered([]);
    // B's host copy now matches what A last sent; that is a change to B, not B's echo.
    expect(props("b", [box("shared")]).action).toBe("hydrate");
  });

  it("treats the same project opened again after it closed as a new project", () => {
    const { publisher, open, props } = editor();
    open("a", [box("one")]);
    publisher.projectChanged(null);
    publisher.projectChanged("a");
    expect(props("a", [box("one")])).toMatchObject({ action: "hydrate", projectChanged: true });
  });

  it("never resumes a held interaction under the next project", () => {
    const { publisher, clock, sent, open, edit } = editor();
    open("a", []);
    edit([box("box")]);
    publisher.interactionStarted();
    publisher.interactionEnded();
    publisher.projectChanged("b");
    clock.advance(500);
    expect(sent).toEqual([]);
  });

  it("flushes a resumed drag publish to its original project when another project opens (#689)", () => {
    const { publisher, clock, sent, sentScenes, open, edit, props } = editor();
    open("a", [box("box")]);
    publisher.interactionStarted();
    edit([box("box", 20)]);
    publisher.interactionEnded();
    clock.advance(179);
    publisher.projectChanged("b");

    expect(sent).toEqual([{ projectId: "a", shapes: ["box"], table: [] }]);
    expect(sentScenes[0]![0]!.width).toBe(20);
    expect(props("b", []).action).toBe("hydrate");
    clock.advance(500);
    expect(sent).toHaveLength(1);
  });

  it("publishes at once when a keyboard move ends", () => {
    const { publisher, sent, open, edit } = editor();
    open("a", []);
    publisher.interactionStarted();
    edit([box("box")]);
    publisher.interactionEnded();
    publisher.publishInteraction();
    expect(sent).toEqual([{ projectId: "a", shapes: ["box"], table: [] }]);
  });
});

describe("classifyHostProps", () => {
  const base = { projectChanged: false, hostTable: "t1", knownTable: "t1", incoming: "s1", echo: "s1", synced: "s1", current: "s1" };

  it("keeps an unpublished local edit when the host re-sends the shapes it already had (#657)", () => {
    expect(classifyHostProps({ ...base, echo: null, incoming: "empty", synced: "empty", current: "box" })).toEqual({ adoptTable: false, action: "echo" });
  });

  it("ignores the echo of the editor's own save", () => {
    expect(classifyHostProps(base)).toEqual({ adoptTable: false, action: "echo" });
  });

  it("adopts a remote table change and rehydrates even when the shapes are unchanged", () => {
    expect(classifyHostProps({ ...base, hostTable: "t2" })).toEqual({ adoptTable: true, action: "hydrate" });
    expect(classifyHostProps({ ...base, hostTable: "t2", echo: null })).toEqual({ adoptTable: true, action: "hydrate" });
  });

  it("skips unchanged shapes and hydrates changed ones or a new project", () => {
    expect(classifyHostProps({ ...base, echo: null })).toEqual({ adoptTable: false, action: "unchanged" });
    expect(classifyHostProps({ ...base, echo: null, incoming: "s2" })).toEqual({ adoptTable: false, action: "hydrate" });
    expect(classifyHostProps({ ...base, echo: null, incoming: "s2", current: "s3" })).toEqual({ adoptTable: false, action: "hydrate" });
    expect(classifyHostProps({ ...base, projectChanged: true })).toEqual({ adoptTable: true, action: "hydrate" });
  });
});
