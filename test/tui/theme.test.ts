import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import { createTheme } from "@byte-mentor/tui";

describe("Byte Mentor theme", () => {
  // Verifies both startup palettes provide complete Markdown and Editor themes with distinct backgrounds.
  test("creates dark and light terminal themes", () => {
    const dark = createTheme("dark");
    const light = createTheme("light");

    expect(Object.keys(dark.markdown)).toEqual(expect.arrayContaining(["heading", "codeBlock"]));
    expect(dark.editor.selectList.noMatch("none")).toContain("none");
    expect(stripVTControlCharacters(dark.background.userMessage("sample"))).toBe("sample");
    expect(dark.background.userMessage("sample")).not.toBe(light.background.userMessage("sample"));
  });
});
