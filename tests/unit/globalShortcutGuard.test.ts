import { describe, expect, it } from "vitest";
import { MODAL_BLOCKING_SELECTOR, isTypingTarget, shouldIgnoreGlobalShortcut, type ShortcutDocument } from "@/lib/globalShortcutGuard";

// The unit suite runs in a node environment, so the document is a stand-in
// that answers the guard's one query from a fixed list of "rendered" elements,
// each described by the attributes a CSS selector would match.
type FakeElement = { tagName: string; attributes: Record<string, string> };

function fakeDocument(elements: FakeElement[]): ShortcutDocument & { queries: string[] } {
  const queries: string[] = [];
  const matches = (element: FakeElement, selector: string) =>
    selector.split(",").map((part) => part.trim()).some((part) => {
      if (part === '[aria-modal="true"]:not([hidden])') return element.attributes["aria-modal"] === "true" && !("hidden" in element.attributes);
      if (part === "[inert]") return "inert" in element.attributes;
      throw new Error(`the fake document does not understand ${part}`);
    });
  return {
    queries,
    querySelector(selector: string) {
      queries.push(selector);
      return elements.find((element) => matches(element, selector)) ?? null;
    },
  };
}

const button = { tagName: "BUTTON", isContentEditable: false };
const body = { tagName: "BODY", isContentEditable: false };
const settingsDialog: FakeElement = { tagName: "DIV", attributes: { role: "dialog", "aria-modal": "true" } };

describe("isTypingTarget", () => {
  it.each(["INPUT", "TEXTAREA", "SELECT", "input"])("treats %s as a typing target", (tagName) => {
    expect(isTypingTarget({ tagName, isContentEditable: false })).toBe(true);
  });

  it("treats contentEditable elements as typing targets", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("does not treat buttons, the body, or non-elements as typing targets", () => {
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window_like())).toBe(false);
  });
});

describe("shouldIgnoreGlobalShortcut", () => {
  it("lets shortcuts through when nothing modal is open and focus is not in a field", () => {
    expect(shouldIgnoreGlobalShortcut({ target: button }, fakeDocument([]))).toBe(false);
    expect(shouldIgnoreGlobalShortcut({ target: body }, fakeDocument([]))).toBe(false);
  });

  it("ignores shortcuts typed into a field", () => {
    expect(shouldIgnoreGlobalShortcut({ target: { tagName: "INPUT" } }, fakeDocument([]))).toBe(true);
  });

  it("ignores shortcuts while an aria-modal dialog is open, even with focus on a button", () => {
    expect(shouldIgnoreGlobalShortcut({ target: button }, fakeDocument([settingsDialog]))).toBe(true);
    expect(shouldIgnoreGlobalShortcut({ target: body }, fakeDocument([settingsDialog]))).toBe(true);
  });

  it("does not count a dialog that is not modal, or a hidden modal", () => {
    const popover: FakeElement = { tagName: "DIV", attributes: { role: "dialog" } };
    const notModal: FakeElement = { tagName: "DIV", attributes: { role: "dialog", "aria-modal": "false" } };
    const hiddenModal: FakeElement = { tagName: "DIV", attributes: { role: "dialog", "aria-modal": "true", hidden: "" } };
    expect(shouldIgnoreGlobalShortcut({ target: button }, fakeDocument([popover, notModal, hiddenModal]))).toBe(false);
  });

  it("ignores shortcuts while part of the page is inert behind a modal", () => {
    const inertBackground: FakeElement = { tagName: "MAIN", attributes: { inert: "" } };
    expect(shouldIgnoreGlobalShortcut({ target: body }, fakeDocument([inertBackground]))).toBe(true);
  });

  it("asks the document with the exported selector", () => {
    const doc = fakeDocument([]);
    shouldIgnoreGlobalShortcut({ target: button }, doc);
    expect(doc.queries).toEqual([MODAL_BLOCKING_SELECTOR]);
  });

  it("lets shortcuts through when there is no document to ask", () => {
    expect(shouldIgnoreGlobalShortcut({ target: button }, undefined)).toBe(false);
  });
});

function window_like() {
  return { addEventListener() {} };
}
