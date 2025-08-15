import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { withTempDir, mockPaths, story as makeStory, comment as makeComment, aggItem, TEST_ISO } from "./helpers";
import { writeJsonFile } from "@utils/json";
import type { AggregatedItem, NormalizedComment, NormalizedStory } from "@config/schemas";
import { SCORE_MIN_AGGREGATE } from "@config/constants";

describe("Aggregation & grouping", () => {
  test("readAggregates filters by SCORE_MIN_AGGREGATE", async () => {
    await withTempDir(async (base) => {
      const { pathFor } = mockPaths(base);
      const { readAggregates } = await import("@scripts/aggregate.mts");

      const storyLow = { id: 74, score: 74, title: "low", timeISO: TEST_ISO, by: "a", url: null };
      const storyHigh = { id: 75, score: 75, title: "high", timeISO: TEST_ISO, by: "b", url: null };

      await writeJsonFile(pathFor.rawItem(74), storyLow);
      await writeJsonFile(pathFor.rawItem(75), storyHigh);
      // Create dummy summary files so loader doesn't complain
      await writeJsonFile(pathFor.postSummary(74), {});
      await writeJsonFile(pathFor.postSummary(75), {});

      const items = await readAggregates([74, 75]);

      expect(items.length).toBe(1);
      expect(items[0]?.id).toBe(75);
      expect(items[0]?.score).toBe(SCORE_MIN_AGGREGATE);
    });
  });

  test("buildAggregatedItem uses fallback commentsSummary when LLM missing", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { buildAggregatedItem, fallbackFromRaw } = await import("@scripts/aggregate.mts");

      const s: NormalizedStory = makeStory({ id: 1, url: null, score: 100, commentIds: [101] });
      const comments: NormalizedComment[] = [makeComment({ id: 101, textPlain: "This is a comment.", parent: s.id })];

      const postSummary = undefined;
      const commentsSummary = undefined; // LLM summary missing
      const tagsSummary = undefined;

      const item = buildAggregatedItem(s, comments, postSummary, commentsSummary, tagsSummary);
      const fallback = fallbackFromRaw(s, comments);

      expect(item.postSummary).toBeUndefined();
      expect(item.commentsSummary).toBe(fallback.commentsSummary);
      expect(item.commentsSummary).toContain("This is a comment.");
    });
  });

  test("Domain extraction strips www and handles bad URLs gracefully", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { extractDomain } = await import("@scripts/aggregate.mts");

      expect(extractDomain("https://www.example.com/x")).toBe("example.com");
      expect(extractDomain("https://example.com/y")).toBe("example.com");
      expect(() => extractDomain("not-a-valid-url")).not.toThrow();
      expect(extractDomain("not-a-valid-url")).toBeUndefined();
      expect(extractDomain(undefined as any)).toBeUndefined();
    });
  });

  test("sortItemsDesc handles invalid dates deterministically", async () => {
    await withTempDir(async (base) => {
      mockPaths(base);
      const { sortItemsDesc } = await import("@scripts/aggregate.mts");

      const itemA: AggregatedItem = aggItem({ id: 1, title: "A", by: "a", timeISO: "2024-01-02T00:00:00Z" }); // Newer
      const itemB: AggregatedItem = aggItem({ id: 2, title: "B", by: "b", timeISO: "2024-01-01T00:00:00Z" }); // Older
      const itemC: AggregatedItem = aggItem({ id: 3, title: "C", by: "c", timeISO: "invalid-date" }); // Invalid

      const sorted = [itemC, itemB, itemA].sort(sortItemsDesc);
      expect(sorted.map((it) => it.title)).toEqual(["A", "B", "C"]);

      // Test deterministic sort for two invalid dates
      const itemD: AggregatedItem = aggItem({ id: 4, title: "D", by: "d", timeISO: "invalid-date-2" });
      const sortedInvalid = [itemC, itemD].sort(sortItemsDesc);
      expect(sortedInvalid.map((it) => it.title)).toEqual(["D", "C"]); // by id desc
    });
  });
});