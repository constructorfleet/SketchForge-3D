import { apiEngine, apiEngineError } from "@/lib/apiEngine";
import { apiContext, apiErrors, apiJson, apiTarget } from "@/lib/apiV1";
import { apiShapeSummary } from "@/lib/apiShapes";

export const runtime = "nodejs";
export const revalidate = false;

/**
 * Split a shape into the bodies it is made of.
 *
 * What a cut leaves behind is often several separate pieces -- a bar cut
 * through the middle is two bars -- and until they are separate shapes a script
 * cannot move, colour or export one of them on its own.
 */
export async function POST(request: Request) {
  const context = await apiContext(request);
  if (context.error) return context.error;
  const { projectId, shapeId } = apiTarget(request);
  if (!projectId) return apiErrors.invalidProjectId();
  if (!shapeId) return apiErrors.shapeIdRequired();

  const separated = await apiEngine(context.root).separate(projectId, shapeId);
  if (!separated.ok) return apiEngineError(separated.failure, { oneShape: true });
  return apiJson({ shapes: separated.value.shapes.map(apiShapeSummary), revision: separated.value.revision });
}
