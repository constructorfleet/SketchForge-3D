/**
 * A parametric box with every roundable edge filleted, from three numbers.
 *
 * The fillet runs on the server with OCCT, so this is the one example that
 * needs real CAD rather than parameters. Two things it demonstrates: the edge
 * listing says which edges can be treated at all -- a seam in a curved surface
 * cannot -- and every wanted edge goes in one request, because OCCT refuses a
 * second treatment on edges adjacent to the first.
 *
 * `replace` keeps one box in one project however many times the numbers change.
 *
 * @type {import("@constructorfleet/sketchforge3d").MacroDefinition<{
 *   width: number, depth: number, height: number, radius: number,
 * }>}
 */
export default {
  name: "Filleted box",
  description: "A box of three dimensions, with its edges rounded.",
  project: { mode: "replace", name: "Filleted box" },
  params: { width: 60, depth: 40, height: 20, radius: 4 },

  async run({ project, params, log }) {
    const box = await project.add({
      kind: "box",
      name: "Body",
      width: params.width,
      depth: params.depth,
      height: params.height,
    });

    const edges = await project.edges(box.id);
    const roundable = edges.filter((edge) => edge.filletable).map((edge) => edge.index);
    log(`${edges.length} edges, ${roundable.length} roundable; filleting at ${params.radius} mm`);

    const treated = await project.fillet(box.id, params.radius, roundable);
    return {
      shapeId: box.id,
      edges: edges.length,
      rounded: roundable.length,
      radius: params.radius,
      triangles: treated.triangles,
      size: { width: treated.shape.width, depth: treated.shape.depth, height: treated.shape.height },
    };
  },
};
