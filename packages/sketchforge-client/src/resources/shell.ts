import type { Transport } from "../http.js";
import type { ShellRequest, ShellResult } from "../types.js";

export class Shell {
  constructor(private readonly transport: Transport) {}

  /**
   * Hollows a solid out on the server, with OCCT.
   *
   * The result is exact, so it still exports to STEP and can still be filleted.
   * Not every shape can be hollowed: a sphere, a torus, a cone and a tube's
   * round wall are each one continuous curved surface, and OCCT refuses to
   * offset them inwards at any thickness.
   */
  async apply(projectId: string, shapeId: string, request: ShellRequest): Promise<ShellResult> {
    return this.transport.send<ShellResult>({
      method: "POST",
      path: "/shell",
      query: { projectId, shapeId },
      body: {
        thickness: request.thickness,
        ...(request.openFaces === undefined ? {} : { openFaces: [...request.openFaces] }),
      },
      retryable: true,
    });
  }

  /** A sealed hollow: a wall all the way round, with the void closed in. */
  hollow(projectId: string, shapeId: string, thickness: number) {
    return this.apply(projectId, shapeId, { thickness });
  }

  /** The usual print: a box with its lid off, which is a tray. */
  tray(projectId: string, shapeId: string, thickness: number, openFaces: ShellRequest["openFaces"] = ["top"]) {
    return this.apply(projectId, shapeId, { thickness, openFaces });
  }
}
