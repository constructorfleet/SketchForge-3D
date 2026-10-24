import { writeFile } from "node:fs/promises";

/**
 * A plate tapped with an M8 thread cutter, cut on the server and exported as STL.
 *
 * This is the whole workflow, end to end through the API: the plate and a
 * M8 thread cutter is added as a shape, `project.cut` subtracts it as one
 * exact boolean, and `project.export` returns
 * the finished part as STL ready for a slicer. Nothing is left for the editor.
 *
 * The thread cutter includes its core, so it removes the bore and helical
 * thread form in one operation.
 *
 * `replace`, because a part is something you iterate on: a second run gives
 * one plate with the new hole, not a second plate beside the first.
 *
 * @type {import("@constructorfleet/sketchforge3d").MacroDefinition<{
 *   size: number, width: number, depth: number, thickness: number, offset: number, out: string,
 * }>}
 */
export default {
  name: "Tapped plate",
  description: "A plate cut with an M8 thread cutter and exported as STL.",
  project: { mode: "replace", name: "Tapped plate" },
  params: {
    /** Metric thread size; the cutter removes its matching thread form. */
    size: 8,
    width: 60,
    depth: 40,
    thickness: 8,
    /** How far the hole sits from the plate's centre along X. */
    offset: 10,
    /** Where to write the STL; empty to keep it in memory only. */
    out: "",
  },

  async run({ project, params, log }) {
    const { shapes } = await project.addMany([
      { kind: "box", name: "Plate", width: params.width, depth: params.depth, height: params.thickness },
      {
        kind: "thread",
        name: `M${params.size} tapped hole`,
        size: `M${params.size}`,
        // Match the plate thickness: longer helical meshes can exceed the
        // server kernel's STL importer limits for boolean cutters.
        length: params.thickness,
        x: params.offset,
        elevation: 0,
      },
    ]);
    const [plate, thread] = shapes;
    if (!plate || !thread) throw new Error("Expected a plate and a thread cutter.");

    // Named operands: the thread need not be marked `hole: true` to be cut away.
    const cut = await project.cut({ solidIds: [plate.id], holeIds: [thread.id] });
    log(`tapped M${params.size} through the plate: ${cut.triangles} triangles`);

    const stl = await project.export({ format: "stl", shapeIds: [cut.shape.id], name: "tapped-plate" });
    if (params.out) {
      await writeFile(params.out, stl.data);
      log(`wrote ${stl.bytes} bytes to ${params.out}`);
    }

    return {
      plateId: cut.shape.id,
      triangles: cut.triangles,
      stl: { filename: stl.filename, bytes: stl.bytes, shapeCount: stl.shapeCount },
    };
  },
};
