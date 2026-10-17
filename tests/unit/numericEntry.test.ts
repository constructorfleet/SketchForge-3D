import { describe, expect, it } from "vitest";
import { appendTypedCharacter, backspaceTypedEntry, typedEntryValue } from "@/lib/numericEntry";

describe("typedEntryValue", () => {
  it("reads a finished number", () => {
    expect(typedEntryValue("90")).toBe(90);
    expect(typedEntryValue("12.75")).toBe(12.75);
    expect(typedEntryValue("-45")).toBe(-45);
  });

  it("is nothing yet for the states a value passes through while typed", () => {
    // Treating these as 0 would snap the shape the moment a minus is pressed.
    for (const partial of [null, "", "-", ".", "-."]) {
      expect(typedEntryValue(partial), partial ?? "null").toBeNull();
    }
  });

  it("is nothing for input that never becomes a number", () => {
    expect(typedEntryValue("abc")).toBeNull();
    expect(typedEntryValue("1.2.3")).toBeNull();
  });

  it("reads a lone zero, which is a real value", () => {
    expect(typedEntryValue("0")).toBe(0);
  });
});

describe("appendTypedCharacter", () => {
  it("accumulates digits", () => {
    expect(appendTypedCharacter(null, "9")).toBe("9");
    expect(appendTypedCharacter("9", "0")).toBe("90");
  });

  it("takes one decimal point only", () => {
    expect(appendTypedCharacter("12", ".")).toBe("12.");
    expect(appendTypedCharacter("12.7", ".")).toBeNull();
  });

  it("takes a minus only at the front, where it is a sign", () => {
    expect(appendTypedCharacter(null, "-")).toBe("-");
    expect(appendTypedCharacter("", "-")).toBe("-");
    expect(appendTypedCharacter("45", "-")).toBeNull();
  });

  it("refuses anything else, so other keys keep their meaning", () => {
    // Shift, arrows and shortcuts must still reach the editor mid-gesture.
    for (const key of ["a", "Shift", "ArrowLeft", "Enter", "Escape", "/", " "]) {
      expect(appendTypedCharacter("1", key), key).toBeNull();
    }
  });

  it("builds a negative decimal one key at a time", () => {
    let entry: string | null = null;
    for (const key of ["-", "1", "2", ".", "7", "5"]) {
      entry = appendTypedCharacter(entry, key);
    }
    expect(entry).toBe("-12.75");
    expect(typedEntryValue(entry)).toBe(-12.75);
  });
});

describe("backspaceTypedEntry", () => {
  it("removes the last character", () => {
    expect(backspaceTypedEntry("123")).toBe("12");
  });

  it("goes back to nothing, handing the gesture back to the pointer", () => {
    expect(backspaceTypedEntry("1")).toBeNull();
    expect(backspaceTypedEntry(null)).toBeNull();
  });

  it("round-trips with appending", () => {
    expect(backspaceTypedEntry(appendTypedCharacter("4", "5"))).toBe("4");
  });
});
