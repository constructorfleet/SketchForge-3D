import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url);

async function routeFiles(directory = "apps/web/src/app"): Promise<string[]> {
  const entries = await readdir(new URL(directory, repositoryRoot), { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  }));
  return found.flat().sort();
}

/**
 * Two ways the static-export build has broken without anyone noticing.
 *
 * It is not run by CI's test job, and it only fails when `STATIC_EXPORT` is
 * actually set -- which the old `npm run export` script did not do outside
 * Windows. These are the cheap source-level checks for both.
 */
describe("static export build", () => {
  it("has no route declaring force-dynamic, which fails the export outright", async () => {
    const offenders: string[] = [];
    for (const path of await routeFiles()) {
      const source = await readFile(new URL(path, repositoryRoot), "utf8");
      if (/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(source)) offenders.push(path);
    }

    // `output: export` refuses the declaration rather than skipping the route,
    // so one of these fails the whole build. A route that reads the request is
    // dynamic in a server build regardless.
    expect(offenders).toEqual([]);
  });

  it("sets STATIC_EXPORT in a way that works off Windows", async () => {
    const packageJson = JSON.parse(await readFile(new URL("package.json", repositoryRoot), "utf8")) as {
      scripts: Record<string, string>;
    };

    // `set VAR=value&& cmd` is cmd.exe syntax: on macOS and Linux it leaves
    // the variable unset, and the script builds a server bundle while claiming
    // to build the static export.
    expect(packageJson.scripts.export).not.toMatch(/(^|\s)set\s+\w+=/);
  });
});
