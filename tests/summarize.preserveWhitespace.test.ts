import { describe, test, expect } from "bun:test";
import { preserveMarkdownWhitespace } from "../scripts/summarize.mts";

describe("summarize.preserveMarkdownWhitespace", () => {
  test("normalizes CRLF to LF, trims trailing spaces, preserves single newlines and paragraphs", () => {
    const input =
      "Line 1  \r\nLine 2   \n\nParagraph 2 line 1  \nParagraph 2 line 2   ";
    const out = preserveMarkdownWhitespace(input);
    expect(out).toBe(
      "Line 1  \nLine 2\n\nParagraph 2 line 1  \nParagraph 2 line 2",
    );
  });

  test("trims outer whitespace but keeps internal structure", () => {
    const input = "\n\n Code `x` line \n\n";
    const out = preserveMarkdownWhitespace(input);
    expect(out).toBe("Code `x` line");
  });
});
