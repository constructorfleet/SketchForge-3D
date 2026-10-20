/**
 * N tapped holes on a ring of radius R, in a round flange.
 *
 * `fresh` rather than `replace`: a bolt circle is the thing someone generates
 * several of to compare, so every run is its own project and no run can
 * overwrite one that is being looked at.
 *
 * @type {import("@constructorfleet/sketchforge3d").MacroDefinition<{
 *   holes: number, radius: number, size: string, thickness: number, bore: number, startAngle: number,
 * }>}
 */
export default {
  name: "Bolt circle",
  description: "A flange with N tapped holes on a ring of radius R.",
  project: "fresh",
  params: {
    holes: 6,
    radius: 30,
    size: "M6",
    thickness: 10,
    /** A central through hole; 0 leaves the flange solid. */
    bore: 20,
    startAngle: 0,
  },

  async run({ project, params, layout, log }) {
    const boltDiameter = Number(params.size.replace(/^M/i, "")) || 6;
    const outerDiameter = 2 * (params.radius + boltDiameter + 6);
    const positions = layout.ring(params.holes, params.radius, { startAngle: params.startAngle });

    log(`flange ${outerDiameter} mm across, ${params.holes} ${params.size} holes on a ${params.radius} mm ring`);

    const shapes = [
      {
        kind: "cylinder",
        name: "Flange",
        width: outerDiameter,
        depth: outerDiameter,
        height: params.thickness,
      },
      ...positions.map((position, index) => ({
        kind: "thread",
        name: `${params.size} hole ${index + 1}`,
        size: params.size,
        length: params.thickness + 2,
        hole: true,
        x: layout.mm(position.x),
        z: layout.mm(position.z),
        elevation: -1,
      })),
    ];

    if (params.bore > 0) {
      shapes.push({
        kind: "cylinder",
        name: "Bore",
        width: params.bore,
        depth: params.bore,
        height: params.thickness + 2,
        elevation: -1,
        hole: true,
      });
    }

    const written = await project.addMany(shapes);
    return {
      outerDiameter,
      holes: positions.length,
      // The angles are worth reporting: a wrong start angle is the usual way a
      // bolt circle comes out unusable, and it is invisible in a shape count.
      angles: positions.map((position) => layout.mm((Math.atan2(position.z, position.x) * 180) / Math.PI)),
      shapesWritten: written.shapes.length,
    };
  },
};
