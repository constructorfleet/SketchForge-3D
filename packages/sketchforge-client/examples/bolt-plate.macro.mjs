/**
 * A plate with a computed row of tapped holes.
 *
 * `replace` rather than `fresh`: a plate is a part someone iterates on, and
 * re-running with a different hole count should give one plate with the new
 * holes rather than a second plate beside the first.
 *
 * The holes are `kind: "thread"` with `hole: true`, which cuts the thread form
 * wider by a clearance and marks the shape as a hole -- so grouping them with
 * the plate in the editor taps the plate. A thread is stored as a mesh, which
 * the server's exact boolean (`project.cut`, `project.group`) cannot cut yet,
 * so the macro leaves them as marked holes for the editor's boolean.
 *
 * @type {import("@constructorfleet/sketchforge3d").MacroDefinition<{
 *   holes: number, spacing: number, size: string, thickness: number, margin: number,
 * }>}
 */
export default {
  name: "Bolt plate",
  description: "A plate with a row of tapped holes, centred on it.",
  project: { mode: "replace", name: "Bolt plate" },
  params: {
    holes: 5,
    spacing: 25,
    size: "M8",
    thickness: 8,
    /** Material left beyond the outermost hole, which sets the plate's size. */
    margin: 12,
  },

  async run({ project, params, layout, log }) {
    const boltDiameter = Number(params.size.replace(/^M/i, "")) || 8;
    const width = (params.holes - 1) * params.spacing + 2 * (boltDiameter / 2 + params.margin);
    const depth = boltDiameter + 2 * params.margin;

    log(`plate ${layout.mm(width)} x ${depth} x ${params.thickness} mm, ${params.holes} ${params.size} holes`);

    const positions = layout.row(params.holes, params.spacing);
    const written = await project.addMany([
      { kind: "box", name: "Plate", width: layout.mm(width), depth, height: params.thickness },
      ...positions.map((position, index) => ({
        kind: "thread",
        name: `${params.size} hole ${index + 1}`,
        size: params.size,
        // Through the plate, and started below it so the first turn is complete.
        length: params.thickness + 2,
        hole: true,
        x: layout.mm(position.x),
        z: layout.mm(position.z),
        elevation: -1,
      })),
    ]);

    return {
      plate: { width: layout.mm(width), depth, thickness: params.thickness },
      holes: positions.length,
      shapesWritten: written.shapes.length,
      revision: written.revision,
    };
  },
};
