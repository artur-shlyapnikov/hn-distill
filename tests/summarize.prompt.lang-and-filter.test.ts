import { describe, test, expect } from "bun:test";
import { buildCommentsPrompt } from "../scripts/summarize.mts";
import type { NormalizedComment } from "../config/schemas.ts";
import { env } from "../config/env.ts";

describe("summarize.buildCommentsPrompt language and filtering", () => {
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
    if (env.SUMMARY_LANG === "en") {
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
