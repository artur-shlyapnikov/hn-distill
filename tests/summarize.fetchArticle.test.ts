import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { pathFor } from "../config/paths.ts";
import { getOrFetchArticleMarkdown } from "../scripts/summarize.mts";
import { ensureDir, writeTextFile } from "../utils/fs.ts";
import { htmlToMd } from "../utils/html-to-md";
import type { HttpClient } from "../utils/http-client.ts";

 
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
     
    const services = {
       
      http: {} as HttpClient,
       
      openrouter: {} as Parameters<typeof getOrFetchArticleMarkdown>[0]["openrouter"],
      fetchArticleMarkdown: async (url: string): Promise<string> => {
        const html = await http.text(url);
        return htmlToMd(html);
      },
    } as Parameters<typeof getOrFetchArticleMarkdown>[0];

    const md1 = await getOrFetchArticleMarkdown(services, story as Parameters<typeof getOrFetchArticleMarkdown>[1]);
    expect(md1).toContain("# Hello");
    expect(http.calls).toBe(1);
    expect(existsSync(path)).toBe(true);

    const md2 = await getOrFetchArticleMarkdown(services, story as Parameters<typeof getOrFetchArticleMarkdown>[1]);
    expect(md2).toBe(md1);
    expect(http.calls).toBe(1); // no refetch

    rmSync(path, { force: true });
  });

  test("returns cached content without HTTP hit if file exists", async () => {
    const story = {
      id: 99_999_902,
      title: "t",
      url: "https://example.com/cached",
      by: "u",
      timeISO: new Date().toISOString(),
      commentIds: [] as number[],
    };
    const path = pathFor.articleMd(story.id);
    await ensureDir(dirname(path));
    await writeTextFile(path, "# Pre-cached");

    const http: Pick<HttpClient, "text"> & { calls: number } = {
      calls: 0,
      text: async () => {
        http.calls++;
        return "";
      },
    };
    const services = {
      http: {} as HttpClient,
      openrouter: {} as Parameters<typeof getOrFetchArticleMarkdown>[0]["openrouter"],
      fetchArticleMarkdown: async (url: string): Promise<string> => {
        const html = await http.text(url);
        return htmlToMd(html);
      },
    } as Parameters<typeof getOrFetchArticleMarkdown>[0];

    const md = await getOrFetchArticleMarkdown(services, story as Parameters<typeof getOrFetchArticleMarkdown>[1]);

    expect(http.calls).toBe(0);
    expect(md).toBe("# Pre-cached");

    rmSync(path, { force: true });
  });

  test("returns undefined and does not cache for empty fetch result", async () => {
    const story = {
      id: 99_999_903,
      title: "t",
      url: "https://example.com/empty",
      by: "u",
      timeISO: new Date().toISOString(),
      commentIds: [] as number[],
    };
    const path = pathFor.articleMd(story.id);
    rmSync(path, { force: true });

    const http: Pick<HttpClient, "text"> & { calls: number } = {
      calls: 0,
      text: async () => {
        http.calls++;
        return "   ";
      }, // whitespace only
    };
    const services = {
      http: {} as HttpClient,
      openrouter: {} as Parameters<typeof getOrFetchArticleMarkdown>[0]["openrouter"],
      fetchArticleMarkdown: async (url: string): Promise<string> => {
        const html = await http.text(url);
        return htmlToMd(html);
      },
    } as Parameters<typeof getOrFetchArticleMarkdown>[0];

    const md = await getOrFetchArticleMarkdown(services, story as Parameters<typeof getOrFetchArticleMarkdown>[1]);

    expect(md).toBeUndefined();
    expect(http.calls).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});
