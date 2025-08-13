import { describe, expect, test } from "bun:test";
import { env as environment } from "../config/env.ts";
import type { NormalizedComment, NormalizedStory } from "../config/schemas.ts";
import { buildCommentsPrompt, buildPostPrompt } from "../scripts/summarize.mts";

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
});
