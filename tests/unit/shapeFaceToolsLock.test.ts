import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { ShapeFaceTools } from "@/components/workplane/ShapeFaceTools";
import { messagesFor } from "@/i18n/translator";
import type { WorkplaneShape } from "@/types/sketchforge";

const shape = {
  id: "exact", name: "Exact", kind: "box", color: "#d41721", x: 0, z: 0, elevation: 0,
  size: 20, width: 20, depth: 20, height: 20, rotation: 0, locked: false, hidden: false,
  cadBrep: "brep", cadBrepFrame: { x: 0, z: 0, elevation: 0, width: 20, depth: 20, height: 20 },
} as unknown as WorkplaneShape;

function render(locked: boolean, draftLocked: boolean) {
  const tools = createElement(ShapeFaceTools, {
    shape, locked, draftLocked, fallbackColor: "#d41721",
    onUpdateFaceColors: () => {}, onApplyDraftFace: () => {},
  });
  return renderToStaticMarkup(createElement(IntlProvider, { locale: "en", messages: messagesFor("en"), children: tools }));
}

/** The opening tag of the first element whose markup matches `pattern`. */
const tag = (html: string, pattern: RegExp) => html.match(pattern)?.[0] ?? "";
const colourInput = (html: string) => tag(html, /<input[^>]*type="color"[^>]*>/);
const draftAngle = (html: string) => tag(html, /<input[^>]*class="face-draft-angle"[^>]*>/);

describe("face tools under a locked part", () => {
  it("keeps face colours open while a draft, which rewrites a locked part, is blocked", () => {
    const html = render(false, true);

    expect(colourInput(html)).not.toBe("");
    expect(colourInput(html)).not.toContain("disabled");
    expect(draftAngle(html)).not.toBe("");
    expect(draftAngle(html)).toContain("disabled");
  });

  it("blocks both on the shape's own lock", () => {
    const html = render(true, true);

    expect(colourInput(html)).toContain("disabled");
    expect(draftAngle(html)).toContain("disabled");
  });
});
