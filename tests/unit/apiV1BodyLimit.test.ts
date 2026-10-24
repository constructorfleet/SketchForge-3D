import { describe, expect, it } from "vitest";
import { apiJsonBody } from "@/lib/apiV1";

describe("apiJsonBody request limits", () => {
  it("rejects a declared oversized body before parsing JSON", async () => {
    const request = new Request("http://localhost/api/v1/shapes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "1024" },
      body: "{\"kind\":\"box\"}",
    });

    const result = await apiJsonBody(request, { maxBytes: 100 });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    await expect((result as Response).json()).resolves.toMatchObject({ code: "invalid_request" });
  });

  it("rejects a streamed body that exceeds the limit", async () => {
    const request = new Request("http://localhost/api/v1/shapes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"kind\":\"box\"}",
    });

    const result = await apiJsonBody(request, { maxBytes: 5 });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });
});
