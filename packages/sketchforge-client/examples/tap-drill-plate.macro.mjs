import { writeFile } from "node:fs/promises";

/**
 * A plate drilled for a tap, cut on the server and exported as STL.
 *
 * This is the whole workflow, end to end through the API: the plate and a
 * cylinder at the tap-drill diameter are added as shapes, `project.cut`
 * subtracts the cylinder as one exact boolean, and `project.export` returns
 * the finished part as STL ready for a slicer. Nothing is left for the editor.
 *
 * The hole is the tap drill rather than the thread form: tap it after
 * printing. A `kind: "thread"` cutter is stored as a mesh, and the server's
 * exact boolean cannot cut that mesh today.
 *
 * `replace`, because a part is something you iterate on: a second run gives
 * one plate with the new hole, not a second plate beside the first.
 *
 * @type {import("@constructorfleet/sketchforge3d").MacroDefinition<{
 *   drill: number, width: number, depth: number, thickness: number, offset: number, out: string,
 * }>}
 */
export default {
  name: "Tap-drill plate",
  description: "A plate drilled for a tap, cut on the server and exported as STL.",
  project: { mode: "replace", name: "Tap-drill plate" },
  params: {
    /** Tap-drill diameter in mm: 6.8 is the drill for an M8 x 1.25 tap. */
    drill: 6.8,
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
        kind: "cylinder",
        name: `${params.drill} mm tap drill`,
        width: params.drill,
        depth: params.drill,
        // Longer than the plate and started below it, so it leaves no skin.
        height: params.thickness + 2,
        x: params.offset,
        elevation: -1,
      },
    ]);
    const [plate, drill] = shapes;
    if (!plate || !drill) throw new Error("Expected a plate and a drill.");

    // Named operands: the drill need not be marked `hole: true` to be cut away.
    const cut = await project.cut({ solidIds: [plate.id], holeIds: [drill.id] });
    log(`drilled ${params.drill} mm through the plate: ${cut.triangles} triangles`);

    const stl = await project.export({ format: "stl", shapeIds: [cut.shape.id], name: "tap-drill-plate" });
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
