import { describe, expect, it } from "vitest";
// @ts-expect-error -- a workflow script, not part of the app's TypeScript build.
import { decodeNotaryKey } from "../../.github/actions/build-mac/write-notary-key.mjs";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n";

describe("decodeNotaryKey", () => {
  it("passes through key contents given as a PEM", () => {
    expect(decodeNotaryKey(PEM)).toBe(PEM);
  });

  it("decodes key contents given as base64", () => {
    expect(decodeNotaryKey(Buffer.from(PEM, "utf8").toString("base64"))).toBe(PEM);
  });

  it("decodes base64 that arrived with line breaks in it", () => {
    const wrapped = Buffer.from(PEM, "utf8").toString("base64").replace(/(.{20})/g, "$1\n");
    expect(decodeNotaryKey(wrapped)).toBe(PEM);
  });

  it("refuses a secret that is neither, rather than writing a file that cannot sign", () => {
    expect(() => decodeNotaryKey("not-a-key")).toThrow(/must be a .p8 path/);
    expect(() => decodeNotaryKey("")).toThrow(/must be a .p8 path/);
  });
});
