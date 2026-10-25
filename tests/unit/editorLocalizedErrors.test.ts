import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalizedError, errorFromPayload, localizedErrorPayload, type ErrorKey } from "@/i18n/LocalizedError";
import { LOCALES, SOURCE_MESSAGES, localeCatalog } from "@/i18n/locales";
import { errorText, translatorFor } from "@/i18n/translator";
import { shelledShapeFields } from "@/lib/shellEditor";

const root = path.resolve(__dirname, "..", "..");
const sourceFile = (...segments: string[]) => path.join(root, "apps", "web", "src", ...segments);

/**
 * Functions whose errors answer an MCP client, not the person at the editor,
 * and how many English errors each writes out: the command dispatcher, its
 * edge treatment helpers and the poll loop reply with `error.message`, in
 * English, to the agent that sent the command. The counts are pinned so a
 * new English error in one of them, or in a new function that happens to
 * share a name, fails here and is looked at.
 *
 * Everything else reaches the status bar through `errorText`, which passes a
 * plain `Error` through verbatim (#387), so it must be a `LocalizedError`.
 */
const AGENT_FACING: Record<string, number> = {
  executeMcpCommand: 33,
  prepareCadModifierForMcp: 4,
  applyCadModifierForMcp: 5,
  poll: 1,
  // The measurement dialog's notices are not localized at all yet; its
  // errors join them when it is.
  runSelectedMeasurement: 1,
};

/** Files whose errors reach the status bar or a panel through `errorText`, scanned with no exemptions. */
const STATUS_BAR_SOURCES = [
  ["lib", "shellEditor.ts"],
  ["lib", "sceneAnalysis.ts"],
  ["lib", "retainedDrafts.ts"],
  // Runs in the CAD worker; its errors come back through localizedErrorPayload.
  ["lib", "engine", "draftPrism.ts"],
] as const;

type PlainError = { owners: string[]; line: number; text: string };

const DECLARATION = /^\s*(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=)/;
/**
 * An `Error` made with its message written out in the source -- a string or
 * template literal, or one in a fallback -- however it is raised: `throw new
 * Error(`, `throw Error(`, `reject(new Error(`, `Promise.reject(new Error(`.
 */
const PLAIN_ERROR = /(?<![\w.])(?:new\s+)?Error\((?=[^;]*["'`])/;

/**
 * The named declarations around a line, innermost first, read from the
 * indentation: each line above it that is indented less, and does not close a
 * block, opens one the line sits in. The editor is formatted consistently
 * enough for that; the pinned counts below fail if it stops being so.
 */
function owners(lines: string[], index: number): string[] {
  const names: string[] = [];
  let threshold = lines[index].search(/\S/);
  for (let current = index - 1; current >= 0 && threshold > 0; current -= 1) {
    const line = lines[current];
    const indent = line.search(/\S/);
    if (indent < 0 || indent >= threshold || /^\s*(?:[})\]]|\/\/|\/?\*)/.test(line)) continue;
    threshold = indent;
    const match = DECLARATION.exec(line);
    if (match) names.push(match[1] ?? match[2]);
  }
  return names;
}

/** Every `Error` with an English message written out in the source, once for each on a line. */
function plainErrors(file: string): PlainError[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const every = new RegExp(PLAIN_ERROR.source, "g");
  return lines.flatMap((line, index) => [...line.matchAll(every)]
    .map(() => ({ owners: owners(lines, index), line: index + 1, text: line.trim() })));
}

const describeSite = (site: PlainError) => `${site.owners[0] ?? "<module>"}:${site.line} ${site.text}`;
const agentFacingOwner = (site: PlainError) => site.owners.find((name) => name in AGENT_FACING);
const editorErrors = () => plainErrors(sourceFile("components", "SketchForgeEditor.tsx"));

/** The keys #387 added, which must be translated in every catalog whether or not the language is complete. */
const ISSUE_387_KEYS = [
  "errors.cadModifier.result.draftPrismMissing",
  "errors.cadModifier.result.draftPrismUnusable",
  "errors.cadModifier.result.draftPrismInvalid",
  "errors.cadModifier.result.faceDraftMissing",
  "errors.cadModifier.result.faceDraftUnusable",
  "errors.cadModifier.result.faceDraftFaceCount",
  "errors.cadModifier.result.shellMissing",
  "errors.cadModifier.result.shellUnusable",
  "errors.cadModifier.result.shellFaceCount",
  "errors.cadModifier.result.exactMissing",
  "errors.cadModifier.result.exactEmpty",
  "errors.cadModifier.result.interferenceMissing",
  "errors.cadModifier.result.wallThicknessMissing",
  "errors.cadModifier.worker.couldNotStart",
  "errors.cadModifier.worker.closed",
  "errors.cadModifier.worker.notReady",
  "errors.cadModifier.worker.timedOut",
  "errors.cadModifier.worker.rejected",
  "errors.cadModifier.draftPrismRange",
  "errors.cadModifier.draftNoFace",
  "errors.editor.exportFailedStatus",
] as const satisfies readonly ErrorKey[];

/**
 * Why a sketch edit refuses to rebuild a draft or an edge treatment (#384,
 * #540): the message is the only explanation the person gets for the sketch
 * staying open, so it is translated in every catalog too.
 */
const SKETCH_REPLAY_REFUSAL_KEYS = [
  "errors.cadModifier.draftNotReplayable",
  "errors.cadModifier.edgeTreatmentNotReplayable",
] as const satisfies readonly ErrorKey[];

const lookup = (tree: object, key: string): unknown => key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);

describe("errors the editor shows in the status bar", () => {
  it("are LocalizedError, not English Error messages, outside agent-facing MCP code", () => {
    const offenders = editorErrors().filter((site) => !agentFacingOwner(site)).map(describeSite);
    expect(offenders).toEqual([]);
  });

  it("are written out in English only as often as each agent-facing MCP function is known to", () => {
    const counts: Record<string, number> = {};
    for (const site of editorErrors()) {
      const owner = agentFacingOwner(site);
      if (owner) counts[owner] = (counts[owner] ?? 0) + 1;
    }
    expect(counts).toEqual(AGENT_FACING);
  });

  it.each(STATUS_BAR_SOURCES.map((segments) => [segments.join("/"), segments] as const))("include %s's", (_label, segments) => {
    expect(plainErrors(sourceFile(...segments)).map(describeSite)).toEqual([]);
  });

  it("catch every way of raising a plain Error", () => {
    const raised = ["throw new Error(\"x\");", "throw Error(`x`);", "reject(new Error('x'));", "return Promise.reject(new Error(\"x\"));"];
    expect(raised.filter((line) => !PLAIN_ERROR.test(line))).toEqual([]);
    const fine = ["throw new LocalizedError(\"errors.x\");", "throw new Error(loop);", "const error = cadModifierWorkerFailureError();", "throw new TypeError(\"x\");"];
    expect(fine.filter((line) => PLAIN_ERROR.test(line))).toEqual([]);
  });

  it("render in the UI language through errorText", () => {
    const error = (() => {
      try {
        shelledShapeFields("shape", Number.NaN, { thickness: 1, openFaces: [] });
      } catch (caught) {
        return caught;
      }
      throw new Error("expected an invalid face count to throw");
    })();
    expect(error).toBeInstanceOf(LocalizedError);
    const key = (error as LocalizedError).key;
    const english = translatorFor("en")(key);
    expect((error as LocalizedError).message).toBe(english);
    for (const locale of LOCALES.filter((entry) => entry.code !== "en")) {
      expect(errorText(translatorFor(locale.code), error, "common.language.label"), locale.code).not.toBe(english);
    }
  });

  it("stay localized after a CAD worker round trip", () => {
    const restored = errorFromPayload(structuredClone(localizedErrorPayload(new LocalizedError("errors.cadModifier.result.draftPrismInvalid"))));
    expect(restored).toBeInstanceOf(LocalizedError);
    expect(errorText(translatorFor("de"), restored, "common.language.label")).toBe(lookup(localeCatalog("de"), "errors.cadModifier.result.draftPrismInvalid"));
  });

  it.each(LOCALES.filter((locale) => locale.code !== "en").map((locale) => locale.code))("are all translated in %s", (code) => {
    const catalog = localeCatalog(code);
    const untranslated = [...ISSUE_387_KEYS, ...SKETCH_REPLAY_REFUSAL_KEYS].filter((key) => {
      const value = lookup(catalog, key);
      return typeof value !== "string" || !value.trim() || value === lookup(SOURCE_MESSAGES, key);
    });
    expect(untranslated).toEqual([]);
  });
});
