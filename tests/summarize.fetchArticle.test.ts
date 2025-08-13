import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { pathFor } from "../config/paths.ts";
import { getOrFetchArticleMarkdown } from "../scripts/summarize.mts";
import htmlToMd from "../utils/html-to-md";
import type { HttpClient } from "../utils/http-client.ts";

// eslint-disable-next-line no-secrets/no-secrets
describe("summarize.getOrFetchArticleMarkdown", () => {
  test("fetches, converts, caches and avoids refetch", async () => {
    const story = {
      id: 99_999_901,
      title: "t",
      url: "https://example.com",
      by: "u",
      timeISO: new Date().toISOString(),
      commentIds: [] as number[],
    };
    const path = pathFor.articleMd(story.id);
    // ensure clean slate
    rmSync(path, { force: true });

    const sampleHtml = "<h1>Hello</h1><p>World</p>";
    const http: Pick<HttpClient, "text"> & { calls: number } = {
      calls: 0,
      text: async () => {
        http.calls++;
        return sampleHtml;
      },
    };
    const services: Parameters<typeof getOrFetchArticleMarkdown>[0] = {
      fetchArticleMarkdown: async (url: string) => {
        const html = await http.text(url);
        return htmlToMd(html);
      },
    };

    const md1 = await getOrFetchArticleMarkdown(services, story as Parameters<typeof getOrFetchArticleMarkdown>[1]);
    expect(md1).toContain("# Hello");
    expect(http.calls).toBe(1);
    expect(existsSync(path)).toBe(true);

    const md2 = await getOrFetchArticleMarkdown(services, story as Parameters<typeof getOrFetchArticleMarkdown>[1]);
    expect(md2).toBe(md1);
    expect(http.calls).toBe(1); // no refetch

    rmSync(path, { force: true });
  });
});
