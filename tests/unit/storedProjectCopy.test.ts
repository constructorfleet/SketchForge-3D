import { describe, expect, it } from "vitest";
import { storedRecordJson } from "@/lib/storedProjectCopy";

// Issue #622: a pre-.skf record that will not load downloads as JSON for repair.
describe("stored record JSON", () => {
  it("writes binary fields as base64 rather than index-keyed objects", () => {
    const json = storedRecordJson({
      record: { id: "p", shapes: [{ id: "s" }] },
      resources: [{ kind: "asset", asset: { id: "a", bytes: new Uint8Array([1, 2, 3, 250]) } }],
      buffer: new Uint8Array([104, 105]).buffer,
    });
    const parsed = JSON.parse(json);
    expect(parsed.resources[0].asset.bytes).toEqual({ $base64: "AQID+g==" });
    expect(parsed.buffer).toEqual({ $base64: "aGk=" });
    expect(parsed.record).toEqual({ id: "p", shapes: [{ id: "s" }] });
  });

  it("encodes a large array without overflowing the call stack", () => {
    const bytes = new Uint8Array(300_000).fill(7);
    const parsed = JSON.parse(storedRecordJson({ bytes }));
    expect(Buffer.from(parsed.bytes.$base64, "base64").equals(Buffer.from(bytes))).toBe(true);
  });
});
