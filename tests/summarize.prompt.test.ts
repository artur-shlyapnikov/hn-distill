import { describe, expect, test } from "bun:test";
import type { NormalizedComment, NormalizedStory } from "../config/schemas.ts";
import { buildCommentsPrompt, buildPostChatMessages, buildPostPrompt } from "../scripts/summarize.mts";
import { withEnvPatch, comment as makeComment, story as makeStory, TEST_ISO } from "./helpers";

describe("scripts/summarize prompt builders", () => {
  test("buildPostPrompt returns only article content slice when present", async () => {
    const s: NormalizedStory = makeStory({ id: 1, url: null, by: "alice" });
    const promptEmpty = await buildPostPrompt(s);
    expect(promptEmpty).toBe(""); // no article -> no prompt

    const md = "# Hello\nThis is article body.";
    const prompt = await buildPostPrompt(s, md);
    // Should contain the markdown body, but no metadata or instruction header
    expect(prompt).toContain("Hello");
    expect(prompt).not.toMatch(/Make it two times shorter|Сделай текст в два раза короче/u);
    expect(prompt).not.toMatch(/Title|Заголовок|Author|Автор|URL|Posted|Опубликовано|Контекст|Context/u);
  });

  test("buildCommentsPrompt respects budget and returns sampleIds", async () => {
    const comments: NormalizedComment[] = Array.from({ length: 20 }, (_, index) =>
      makeComment({ id: index + 1, textPlain: "x".repeat(500) })
    );
    const { prompt, sampleIds } = await buildCommentsPrompt(comments);
    expect(sampleIds.length).toBe(5);
    expect(prompt.length).toBeGreaterThan(0);
    // lines truncated to ~400 chars per comment
    const lines = prompt.split("\n").slice(1); // skip header
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(430); // account for prefix
    }
  });

  test("header reflects English and excludes empty comments", async () => {
    await withEnvPatch({ SUMMARY_LANG: "en" }, async () => {
      const comments: NormalizedComment[] = [
        makeComment({ id: 1, by: "alice", textPlain: " Hello   world ", depth: 1 }),
        makeComment({ id: 2, by: "bob", textPlain: "   ", depth: 2 }), // blank -> excluded
        makeComment({ id: 3, by: "carol", textPlain: "x".repeat(1000), depth: 3 }),
      ];

      const { prompt, sampleIds } = await buildCommentsPrompt(comments);
      const lines = prompt.split("\n");
      expect(lines[0]).toContain("Language: en");
      // Depth prefixes and usernames
      expect(prompt).toContain("@alice [d1]");
      expect(prompt).toContain("@carol [d3]");
      expect(prompt).not.toContain("@bob"); // blank excluded

      // Truncation per line (prefix + 400 char slice)
      const contentLines = lines.slice(1);
      for (const line of contentLines) {
        expect(line.length).toBeLessThanOrEqual(430);
      }

      // sampleIds should exclude blank one and take first non-blank up to 5
      expect(sampleIds).toEqual([1, 3]);
    });
  });

  test("header reflects Russian", async () => {
    await withEnvPatch({ SUMMARY_LANG: "ru" }, async () => {
      const comments: NormalizedComment[] = [makeComment({ id: 1, by: "ivan", textPlain: "Привет", depth: 2 })];
      const { prompt } = await buildCommentsPrompt(comments);
      const lines = prompt.split("\n");
      expect(lines[0]).toContain("Language: ru");
      expect(prompt).toContain("@ivan [d2]");
    });
  });

  test("buildPostPrompt obeys ARTICLE_SLICE_CHARS", async () => {
    await withEnvPatch({ ARTICLE_SLICE_CHARS: 100 }, async () => {
      const s: NormalizedStory = makeStory({ id: 1, url: null, by: "a" });
      const articleMd = "x".repeat(200);
      const prompt = await buildPostPrompt(s, articleMd);
      expect(prompt.length).toBe(100);
      expect(prompt).toBe("x".repeat(100));
    });
  });

  test("buildPostChatMessages includes correct system instruction per lang", async () => {
    await withEnvPatch({ SUMMARY_LANG: "en" }, async () => {
      const messages = buildPostChatMessages("article");
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toBe(
        "make the content two times shorter, don't mention the title, publication date and other metadata; format the output as markdown"
      );
    });

    await withEnvPatch({ SUMMARY_LANG: "ru" }, async () => {
      const messages = buildPostChatMessages("article");
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toBe(
        "переведи на русский содержимое (не указывай заголовок, дату и другие метаданные), сократи в два раза; форматируй вывод как markdown"
      );
    });
  });

  test("buildCommentsPrompt preserves sampleIds order and cap", async () => {
    const base: Partial<NormalizedComment> = { by: "u", timeISO: TEST_ISO, parent: 0, depth: 1 };
    const comments: NormalizedComment[] = [
      { id: 1, textPlain: "one" },
      { id: 2, textPlain: "   " }, // blank
      { id: 3, textPlain: "three" },
      { id: 4, textPlain: "four" },
      { id: 5, textPlain: "five" },
      { id: 6, textPlain: "six" },
      { id: 7, textPlain: "seven" },
      { id: 8, textPlain: "" }, // blank
    ].map((c) => ({ ...base, ...c } as NormalizedComment));

    const { sampleIds } = await buildCommentsPrompt(comments);

    expect(sampleIds.length).toBe(5);
    expect(sampleIds).toEqual([1, 3, 4, 5, 6]); // first 5 non-blank, in order
  });
});
