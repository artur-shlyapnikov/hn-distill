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

  test("default export works", () => {
    const html = "<p>Hello</p>";
    expect(htmlToMdDefault(html)).toBe("Hello");
  });
});
