import { describe, test, expect } from "bun:test";
import { htmlToMd } from "../utils/htmlToMd.ts";
import htmlToMdDefault from "../utils/htmlToMd.ts";

describe("utils/htmlToMd", () => {
  test("converts basic HTML elements", () => {
    const html = "<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> text.</p>";
    const md = htmlToMd(html);
    expect(md).toContain("# Title");
    expect(md).toContain("Some **bold** and _italic_ text.");
  });

  test("converts code blocks using fenced style", () => {
    const html = "<pre><code class=\"language-js\">console.log('hi')</code></pre>";
    const md = htmlToMd(html);
    expect(md).toContain("```js");
    expect(md).toContain("console.log('hi')");
  });

  test("handles headings, links, lists and ignores scripts/styles", () => {
    const html = `
      <h1>Main</h1>
      <p>Visit <a href="https://example.com">link</a></p>
      <ul><li>One</li><li>Two</li></ul>
      <script>console.log('x')</script>
      <style>p { color: red; }</style>
    `;
    const md = htmlToMd(html);
    expect(md).toContain("# Main");
    expect(md).toContain("[link](https://example.com)");
    expect(md).toContain("*   One");
    expect(md).toContain("*   Two");
    expect(md).not.toContain("console.log");
    expect(md).not.toContain("color: red");
  });

  test("default export works", () => {
    const html = "<p>Hello</p>";
    expect(htmlToMdDefault(html)).toBe("Hello");
  });
});
