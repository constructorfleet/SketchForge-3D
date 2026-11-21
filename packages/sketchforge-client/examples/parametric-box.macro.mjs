/**
 * A box whose width and position follow one `wall` parameter.
 *
 * The box is created with expressions instead of numbers, then the parameter
 * is changed: the server rebuilds the bound box in the same write, and the
 * reply carries the rebuilt shape. The exact volume and centre of mass before
 * and after show that the solid itself moved and grew, not only its summary.
 *
 * `fresh`, because a parameter table outlives a `replace` run, which only
 * empties the shapes.
 *
 * @type {import("@constructorfleet/sketchforge3d").MacroDefinition<{ wall: number, resized: number }>}
 */
export default {
  name: "Parametric box",
  description: "A box bound to a wall parameter, rebuilt when the parameter changes.",
  project: "fresh",
  params: { wall: 2, resized: 3 },

  async run({ project, params, log }) {
    await project.addParameter({ name: "wall", expression: `${params.wall} mm`, dimension: "length" });
    const box = await project.add({
      kind: "box",
      name: "Body",
      depth: 10,
      height: 10,
      expressions: { width: "wall * 5", x: "wall * 10" },
    });
    const before = await project.propertiesOf(box.id);

    const changed = await project.updateParameter("wall", { expression: `${params.resized} mm` });
    const rebuilt = changed.shapes.find((shape) => shape.id === box.id);
    log(`wall ${params.wall} -> ${changed.parameter?.value} mm rebuilt ${changed.shapes.length} shape(s)`);
    const after = await project.propertiesOf(box.id);

    return {
      shapeId: box.id,
      expressions: box.expressions,
      before: { width: box.width, x: box.x, volume: before.volume, centerX: before.centerOfMass.x },
      after: { width: rebuilt?.width, x: rebuilt?.x, volume: after.volume, centerX: after.centerOfMass.x },
      rebuilt: changed.shapes.length,
    };
  },
};
