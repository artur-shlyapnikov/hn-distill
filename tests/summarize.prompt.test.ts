import { describe, expect, test } from "bun:test";
import { env as environment } from "../config/env.ts";
import type { NormalizedComment, NormalizedStory } from "../config/schemas.ts";
import { buildCommentsPrompt, buildPostChatMessages, buildPostPrompt } from "../scripts/summarize.mts";

describe("scripts/summarize prompt builders", () => {
  test("buildPostPrompt returns only article content slice when present", async () => {
    const story: NormalizedStory = {
      id: 1,
      title: "T",
      url: null,
      by: "alice",
      timeISO: new Date().toISOString(),
      commentIds: [],
    };
    const promptEmpty = await buildPostPrompt(story);
    expect(promptEmpty).toBe(""); // no article -> no prompt

    const md = "# Hello\nThis is article body.";
    const prompt = await buildPostPrompt(story, md);
    // Should contain the markdown body, but no metadata or instruction header
    expect(prompt).toContain("Hello");
    expect(prompt).not.toMatch(/Make it two times shorter|Сделай текст в два раза короче/u);
    expect(prompt).not.toMatch(/Title|Заголовок|Author|Автор|URL|Posted|Опубликовано|Контекст|Context/u);
  });

  test("buildCommentsPrompt respects budget and returns sampleIds", async () => {
    const comments: NormalizedComment[] = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      by: "u",
      timeISO: new Date().toISOString(),
      textPlain: "x".repeat(500),
      parent: 1,
      depth: 1,
    }));
    const { prompt, sampleIds } = await buildCommentsPrompt(comments);
    expect(sampleIds.length).toBe(5);
    expect(prompt.length).toBeGreaterThan(0);
    // lines truncated to ~400 chars per comment
    const lines = prompt.split("\n").slice(1); // skip header
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(430); // account for prefix
    }
  });

  test("header reflects env.SUMMARY_LANG and excludes empty comments", async () => {
    const comments: NormalizedComment[] = [
      {
        id: 1,
        by: "alice",
        timeISO: new Date().toISOString(),
        textPlain: " Hello   world ",
        parent: 0,
        depth: 1,
      },
      {
        id: 2,
        by: "bob",
        timeISO: new Date().toISOString(),
        textPlain: "   ",
        parent: 0,
        depth: 2,
      }, // blank -> excluded
      {
        id: 3,
        by: "carol",
        timeISO: new Date().toISOString(),
        textPlain: "x".repeat(1000),
        parent: 0,
        depth: 3,
      },
    ];

    const { prompt, sampleIds } = await buildCommentsPrompt(comments);
    const lines = prompt.split("\n");
    // Header based on language
    if (environment.SUMMARY_LANG === "en") {
      expect(lines[0]).toContain("Language: en");
    } else {
      expect(lines[0]).toContain("Language: ru");
    }
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

  test("buildPostPrompt obeys ARTICLE_SLICE_CHARS", async () => {
    const originalSliceChars = environment.ARTICLE_SLICE_CHARS;
    environment.ARTICLE_SLICE_CHARS = 100;

    const story: NormalizedStory = {
      id: 1,
      title: "T",
      url: null,
      by: "a",
      timeISO: new Date().toISOString(),
      commentIds: [],
    };
    const articleMd = "x".repeat(200);

    const prompt = await buildPostPrompt(story, articleMd);

    expect(prompt.length).toBe(100);
    expect(prompt).toBe("x".repeat(100));

    environment.ARTICLE_SLICE_CHARS = originalSliceChars;
  });

  test("buildPostChatMessages includes correct system instruction per lang", async () => {
    const originalLang = environment.SUMMARY_LANG;

    // English
    environment.SUMMARY_LANG = "en";
    let messages = buildPostChatMessages("article");
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe(
      "make the content two times shorter, don't mention the title, publication date and other metadata; format the output as markdown"
    );

    // Russian
    environment.SUMMARY_LANG = "ru";
    messages = buildPostChatMessages("article");
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe(
      "переведи на русский содержимое (не указывай заголовок, дату и другие метаданные), сократи в два раза; форматируй вывод как markdown"
    );

    environment.SUMMARY_LANG = originalLang;
  });

  test("buildCommentsPrompt preserves sampleIds order and cap", async () => {
    const comments: NormalizedComment[] = [
      { id: 1, textPlain: "one" },
      { id: 2, textPlain: "   " }, // blank
      { id: 3, textPlain: "three" },
      { id: 4, textPlain: "four" },
      { id: 5, textPlain: "five" },
      { id: 6, textPlain: "six" },
      { id: 7, textPlain: "seven" },
      { id: 8, textPlain: "" }, // blank
    ].map(
      (c) =>
        ({
          by: "u",
          timeISO: new Date().toISOString(),
          parent: 0,
          depth: 1,
          ...c,
        }) as NormalizedComment
    );

    const { sampleIds } = await buildCommentsPrompt(comments);

    expect(sampleIds.length).toBe(5);
    expect(sampleIds).toEqual([1, 3, 4, 5, 6]); // first 5 non-blank, in order
  });
});
