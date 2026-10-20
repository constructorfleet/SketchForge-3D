import type { Transport } from "../http.js";
import type { FaceDirection, FaceSummary } from "../types.js";

export class Faces {
  constructor(private readonly transport: Transport) {}

  /** Every face, numbered as a shell request refers to them. */
  async list(projectId: string, shapeId: string): Promise<FaceSummary[]> {
    const payload = await this.transport.send<{ faces: FaceSummary[] }>({
      method: "GET",
      path: "/faces",
      query: { projectId, shapeId },
    });
    return payload.faces;
  }

  /**
   * The indexes of the faces pointing a given way, which is usually one.
   *
   * A shell request can name the direction itself, so this is for a caller that
   * wants to know what it would get first -- or to find out that this shape has
   * no flat face pointing that way before asking for a tray with no lid off.
   */
  async facing(projectId: string, shapeId: string, direction: FaceDirection): Promise<number[]> {
    const faces = await this.list(projectId, shapeId);
    return faces.filter((face) => face.facing === direction).map((face) => face.index);
  }
}
