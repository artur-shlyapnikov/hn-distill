import { describe, expect, test } from "bun:test";
import { mdToHtml } from "../utils/md-to-html.ts";

describe("utils/mdToHtml", () => {
  test("renders basic markdown elements", () => {
    const md = ["# Title", "Some **bold** and _italic_ and `code`.", "", "- One", "- Two"].join("\n");
    const html = mdToHtml(md);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>One</li>");
  });

  test("renders fenced code block with language class", () => {
    const md = ["```js", "console.log('hi')", "```"].join("\n");
    const html = mdToHtml(md);
    expect(html).toMatch(/<pre><code class=\"language-js\">[\s\S]*console\.log/);
  });

  test("sanitizes dangerous HTML and links", () => {
    const md = ["<script>alert('x')</script>", "", "[bad](javascript:alert('x')) and [ok](https://example.com)"].join(
      "\n"
    );
    const html = mdToHtml(md);
    expect(html).not.toContain("<script>");
    // no dangerous href emitted; text may remain as-is
    expect(html).not.toMatch(/href=\"javascript:/i);
    // safe link attributes added to valid links
    expect(html).toMatch(/<a [^>]*target=\"_blank\"/);
    expect(html).toMatch(/rel=\"noopener noreferrer nofollow\"/);
  });

  test("auto-linkifies bare URLs", () => {
    const md = "Visit https://example.com for more";
    const html = mdToHtml(md);
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('target="_blank"');
  });
});
