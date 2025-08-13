import { describe, expect, test } from "bun:test";
import { clamp, htmlToPlain, seemsEnglish } from "../utils/text.ts";

describe("utils/text", () => {
  test("htmlToPlain strips tags, decodes entities, normalizes breaks", () => {
    const input = "<p>Hello world</p><ul><li>One</li><li>Two</li></ul>";
    const out = htmlToPlain(input);
    expect(out).toContain("Hello world");
    expect(out).toContain("• One");
    expect(out).not.toMatch(/<[^>]{1,100}>/u);
    expect(out.endsWith("Two")).toBeTrue();
  });

  test("htmlToPlain collapses excessive newlines and trims", () => {
    const input = "<p>A</p><p>B</p><p>C</p>";
    const out = htmlToPlain(input);
    const parts = out.split("\n\n");
    expect(parts.length).toBe(3);
    expect(out.startsWith("A")).toBeTrue();
    expect(out.endsWith("C")).toBeTrue();
  });

  test("clamp respects length", () => {
    expect(clamp("abc", 2)).toBe("ab");
    expect(clamp("abc", 3)).toBe("abc");
  });

  test("seemsEnglish detects English vs Cyrillic and handles mixed", () => {
    expect(seemsEnglish("This is English.")).toBeTrue();
    expect(seemsEnglish("Это русский текст")).toBeFalse();
    expect(seemsEnglish("")).toBeFalse();
    expect(seemsEnglish("Hello мир")).toBeFalse();
  });
});
