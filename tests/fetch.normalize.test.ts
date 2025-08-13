import { describe, expect, test } from "bun:test";
import type { HnItemRaw } from "../config/schemas.ts";
import { normalizeStory } from "../scripts/fetch-hn.mts";

describe("scripts/fetch-hn normalizeStory", () => {
  test("throws on non-story type", () => {
    const raw = {
      id: 1,
      type: "comment",
      time: 1_700_000_000,
    } as unknown as HnItemRaw;
    expect(() => normalizeStory(raw)).toThrow();
  });

  test("normalizes and clamps fields, converts time to ISO", () => {
    const raw: HnItemRaw = {
      id: 2,
      type: "story",
      title: "Hi",
      url: "http://example.com",
      by: "alice",
      time: 1_700_000_000,
      kids: [3, 4],
      score: 10,
      descendants: 5,
    };
    const s = normalizeStory(raw);
    expect(s.id).toBe(2);
    expect(typeof s.timeISO).toBe("string");
    expect(Array.isArray(s.commentIds)).toBeTrue();
    expect(s.url).toBe("http://example.com/");
    expect(s.by).toBe("alice");
    expect(s.score).toBe(10);
    expect(s.descendants).toBe(5);
  });

  test("handles missing url and missing by/title with defaults", () => {
    const raw = {
      id: 3,
      type: "story",
      time: 1_700_000_001,
    } as unknown as HnItemRaw;
    const s = normalizeStory(raw);
    expect(s.url).toBeNull();
    expect(s.by.length).toBeGreaterThan(0);
    expect(s.title.length).toBeGreaterThan(0);
  });
});
