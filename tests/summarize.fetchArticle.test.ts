import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, writeTextFile } from "../utils/fs.ts";
import { htmlToMd } from "../utils/html-to-md";
import { makeMockHttp, story as makeStory, mockPaths, withTempDir } from "./helpers";

describe("summarize.getOrFetchArticleMarkdown", () => {
  test("fetches, converts, caches and avoids refetch", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { getOrFetchArticleMarkdown } = await import("../scripts/summarize.mts");

      const s = makeStory({ id: 99_999_901, url: "https://example.com" });
      const path = pathFor.articleMd(s.id);
      // ensure clean slate
      rmSync(path, { force: true });

      const sampleHtml = "<h1>Hello</h1><p>World</p>";
      const mockResult = makeMockHttp({ "/^https:\\/\\/example\\.com\\/?$/u": sampleHtml });
      const { http } = mockResult;
      const services = {
        http,
        openrouter: {} as Parameters<typeof getOrFetchArticleMarkdown>[0]["openrouter"],
        fetchArticleMarkdown: async (url: string): Promise<string> => {
          const html = await http.text(url);
          return htmlToMd(html);
        },
      } as Parameters<typeof getOrFetchArticleMarkdown>[0];

      const md1 = await getOrFetchArticleMarkdown(services, s);
      expect(md1).toContain("# Hello");
      expect(mockResult.calls).toBe(1);
      expect(existsSync(path)).toBe(true);

      const md2 = await getOrFetchArticleMarkdown(services, s);
      expect(md2).toBe(md1);
      expect(mockResult.calls).toBe(1); // no refetch

      rmSync(path, { force: true });
    });
  });

  test("returns cached content without HTTP hit if file exists", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { getOrFetchArticleMarkdown } = await import("../scripts/summarize.mts");

      const s = makeStory({ id: 99_999_902, url: "https://example.com/cached" });
      const path = pathFor.articleMd(s.id);
      await ensureDir(dirname(path));
      await writeTextFile(path, "# Pre-cached");

      const mockResult = makeMockHttp({ "/^https:\\/\\/example\\.com\\/cached\\/?$/u": "" });
      const { http } = mockResult;
      const services = {
        http,
        openrouter: {} as Parameters<typeof getOrFetchArticleMarkdown>[0]["openrouter"],
        fetchArticleMarkdown: async (url: string): Promise<string> => {
          const html = await http.text(url);
          return htmlToMd(html);
        },
      } as Parameters<typeof getOrFetchArticleMarkdown>[0];

      const md = await getOrFetchArticleMarkdown(services, s);

      expect(mockResult.calls).toBe(0);
      expect(md).toBe("# Pre-cached");

      rmSync(path, { force: true });
    });
  });

  test("returns undefined and does not cache for empty fetch result", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { getOrFetchArticleMarkdown } = await import("../scripts/summarize.mts");

      const s = makeStory({ id: 99_999_903, url: "https://example.com/empty" });
      const path = pathFor.articleMd(s.id);
      rmSync(path, { force: true });

      const mockResult = makeMockHttp({ "/^https:\\/\\/example\\.com\\/empty\\/?$/u": "   " });
      const { http } = mockResult;
      const services = {
        http,
        openrouter: {} as Parameters<typeof getOrFetchArticleMarkdown>[0]["openrouter"],
        fetchArticleMarkdown: async (url: string): Promise<string> => {
          const html = await http.text(url);
          return htmlToMd(html);
        },
      } as Parameters<typeof getOrFetchArticleMarkdown>[0];

      const md = await getOrFetchArticleMarkdown(services, s);

      expect(md).toBeUndefined();
      expect(mockResult.calls).toBe(1);
      expect(existsSync(path)).toBe(false);
    });
  });
});
