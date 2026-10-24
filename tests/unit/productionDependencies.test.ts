import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lockfile = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, { dev?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
};

describe("production dependency boundaries", () => {
  it("keeps @vitest/mocker out of the production install tree", () => {
    expect(manifest.dependencies?.["@vitest/mocker"]).toBeUndefined();
    expect(manifest.devDependencies?.["@vitest/mocker"]).toBeDefined();
    expect(lockfile.packages[""].dependencies?.["@vitest/mocker"]).toBeUndefined();
    expect(lockfile.packages[""].devDependencies?.["@vitest/mocker"]).toBeDefined();
    expect(lockfile.packages["node_modules/@vitest/mocker"].dev).toBe(true);
    expect(lockfile.packages["node_modules/vite"].dev).toBe(true);
  });
});
