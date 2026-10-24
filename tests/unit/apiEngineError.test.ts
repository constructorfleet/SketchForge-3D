import { describe, expect, it } from "vitest";
import { apiEngineError } from "@/lib/apiEngine";

describe("API geometry failure mapping", () => {
  it("reports an unexpected boolean-kernel failure as a geometry error", async () => {
    const response = apiEngineError({ reason: "geometry_failed", message: "The CAD kernel could not complete that cut.", status: 500 });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "geometry_failed", error: "The CAD kernel could not complete that cut." });
  });
});
