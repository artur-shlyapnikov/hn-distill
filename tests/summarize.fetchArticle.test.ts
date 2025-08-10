import { describe, test, expect } from "bun:test";
import { getOrFetchArticleMarkdown } from "../scripts/summarize.mts";
import { pathFor } from "../config/paths.ts";
import htmlToMd from "../utils/htmlToMd.ts";
import type { HttpClient } from "../utils/http-client.ts";
import { rmSync, existsSync } from "fs";

describe("summarize.getOrFetchArticleMarkdown", () => {
  test("fetches, converts, caches and avoids refetch", async () => {
    const story = {
      id: 99999901,
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
      text: async (_url: string) => {
        http.calls++;
        return sampleHtml;
      },
    };
    const services = {
      fetchArticleMarkdown: async (url: string) => {
        const html = await http.text(url);
        return htmlToMd(html);
      },
    } as any;

    const md1 = await getOrFetchArticleMarkdown(services, story as any);
    expect(md1).toContain("# Hello");
    expect(http.calls).toBe(1);
    expect(existsSync(path)).toBe(true);

    const md2 = await getOrFetchArticleMarkdown(services, story as any);
    expect(md2).toBe(md1);
    expect(http.calls).toBe(1); // no refetch

    rmSync(path, { force: true });
  });
});

