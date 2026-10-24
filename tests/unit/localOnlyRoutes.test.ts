import { describe, expect, it } from "vitest";
import { addressedToLoopbackHost, localOnlyOptIn } from "@/lib/localOnlyRoutes";

describe("local-only route helpers", () => {
  it("recognises loopback host names in the request URL", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]"]) {
      expect(addressedToLoopbackHost(new Request(`http://${host}:3000/api/app-update`)), host).toBe(true);
    }
  });

  it("does not treat a LAN or public host as loopback", () => {
    for (const host of ["192.168.1.10", "sketchforge.example.test", "127.0.0.1.example.test", "localhost.example.test"]) {
      expect(addressedToLoopbackHost(new Request(`http://${host}:3000/api/app-update`)), host).toBe(false);
    }
  });

  it("enables an opt-in only for an explicit 1 or true", () => {
    expect(localOnlyOptIn("FLAG", { FLAG: "1" })).toBe(true);
    expect(localOnlyOptIn("FLAG", { FLAG: " TRUE " })).toBe(true);
    for (const value of [undefined, "", "0", "false", "yes", "on"]) {
      expect(localOnlyOptIn("FLAG", { FLAG: value }), String(value)).toBe(false);
    }
  });
});
