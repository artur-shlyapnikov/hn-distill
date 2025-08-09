import { describe, test, expect } from "bun:test";
import { fallbackFromRaw } from "../scripts/aggregate.mts";
import type { NormalizedStory, NormalizedComment } from "../config/schemas.ts";

describe("scripts/aggregate fallbackFromRaw", () => {
  test("does not produce postSummary fallback; commentsSummary falls back to combined comment text", () => {
    const story: NormalizedStory = {
      id: 1,
      title: "Title",
      url: "http://a.com/",
      by: "b",
      timeISO: new Date().toISOString(),
      commentIds: [],
    };
    const comments: NormalizedComment[] = [
      {
        id: 11,
        by: "u",
        timeISO: story.timeISO,
        textPlain: "One",
        parent: 1,
        depth: 1,
      },
      {
        id: 12,
        by: "u",
        timeISO: story.timeISO,
        textPlain: "Two",
        parent: 1,
        depth: 1,
      },
    ];
    const fb = fallbackFromRaw(story, comments);
    expect(fb.postSummary).toBeUndefined();
    expect(fb.commentsSummary).toContain("One");
    expect(fb.commentsSummary).toContain("Two");
    expect((fb.commentsSummary ?? "").length).toBeLessThanOrEqual(280);
  });

  test("commentsSummary undefined if no comments", () => {
    const story: NormalizedStory = {
      id: 2,
      title: "T",
      url: null,
      by: "b",
      timeISO: new Date().toISOString(),
      commentIds: [],
    };
    const fb = fallbackFromRaw(story, []);
    expect(fb.commentsSummary).toBeUndefined();
    expect(fb.postSummary).toBeUndefined();
  });
});
