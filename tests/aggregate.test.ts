import { describe, expect, test, beforeAll, afterAll , mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fallbackFromRaw } from "@scripts/aggregate.mts";
import { writeJsonFile } from "@utils/json";
import type { AggregatedItem, NormalizedComment, NormalizedStory } from "@config/schemas";
import { SCORE_MIN_AGGREGATE } from "@config/constants";

// Mock the pathing to use a temporary directory
let tmpDir: string;
const TmpPaths = {
  raw: {
    items: "",
    comments: "",
  },
  summaries: "",
};
const TmpPathFor = {
  rawItem: (id: number) => join(TmpPaths.raw.items, `${id}.json`),
  rawComments: (id: number) => join(TmpPaths.raw.comments, `${id}.json`),
  postSummary: (id: number) => join(TmpPaths.summaries, `${id}.post.json`),
  commentsSummary: (id: number) => join(TmpPaths.summaries, `${id}.comments.json`),
  tagsSummary: (id: number) => join(TmpPaths.summaries, `${id}.tags.json`),
};

// We will re-import after mocking
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readAggregatesPatched: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buildAggregatedItem: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sortItemsDesc: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractDomain: any;

describe("Aggregation & grouping", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agg-test-"));
    TmpPaths.raw.items = join(tmpDir, "raw", "items");
    TmpPaths.raw.comments = join(tmpDir, "raw", "comments");
    TmpPaths.summaries = join(tmpDir, "summaries");

    mock.module("@config/paths", () => ({
      PATHS: TmpPaths,
      pathFor: TmpPathFor,
    }));

    // We need to re-import after mocking
    const mod = await import("@scripts/aggregate.mts");
    readAggregatesPatched = mod.readAggregates;
    buildAggregatedItem = mod.buildAggregatedItem;
    sortItemsDesc = mod.sortItemsDesc;
    extractDomain = mod.extractDomain;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("22. readAggregates filters by SCORE_MIN_AGGREGATE", async () => {
    const storyLow = { id: 74, score: 74, title: "low", timeISO: new Date().toISOString(), by: "a", url: null };
    const storyHigh = { id: 75, score: 75, title: "high", timeISO: new Date().toISOString(), by: "b", url: null };

    await writeJsonFile(TmpPathFor.rawItem(74), storyLow);
    await writeJsonFile(TmpPathFor.rawItem(75), storyHigh);
    // Create dummy summary files so loader doesn't complain
    await writeJsonFile(TmpPathFor.postSummary(74), {});
    await writeJsonFile(TmpPathFor.postSummary(75), {});

    const items = await readAggregatesPatched([74, 75]);

    expect(items.length).toBe(1);
    expect(items[0].id).toBe(75);
    expect(items[0].score).toBe(SCORE_MIN_AGGREGATE);
  });

  test("23. buildAggregatedItem uses fallback commentsSummary when LLM missing", () => {
    const story: NormalizedStory = {
      id: 1,
      title: "T",
      url: null,
      by: "u",
      timeISO: "2024-01-01T00:00:00Z",
      commentIds: [101],
      score: 100,
    };
    const comments: NormalizedComment[] = [
      { id: 101, by: "c", timeISO: story.timeISO, textPlain: "This is a comment.", parent: 1, depth: 1 },
    ];
    const postSummary = undefined;
    const commentsSummary = undefined; // LLM summary missing
    const tagsSummary = undefined;

    const item = buildAggregatedItem(story, comments, postSummary, commentsSummary, tagsSummary);
    const fallback = fallbackFromRaw(story, comments);

    expect(item.postSummary).toBeUndefined();
    expect(item.commentsSummary).toBe(fallback.commentsSummary);
    expect(item.commentsSummary).toContain("This is a comment.");
  });

  test("24. Domain extraction strips www and handles bad URLs gracefully", () => {
    expect(extractDomain("https://www.example.com/x")).toBe("example.com");
    expect(extractDomain("https://example.com/y")).toBe("example.com");
    expect(() => extractDomain("not-a-valid-url")).not.toThrow();
    expect(extractDomain("not-a-valid-url")).toBeUndefined();
    expect(extractDomain()).toBeUndefined();
  });

  test("25. sortItemsDesc handles invalid dates deterministically", () => {
    const itemA: AggregatedItem = {
      id: 1,
      title: "A",
      url: null,
      by: "a",
      timeISO: "2024-01-02T00:00:00Z",
    }; // Newer
    const itemB: AggregatedItem = {
      id: 2,
      title: "B",
      url: null,
      by: "b",
      timeISO: "2024-01-01T00:00:00Z",
    }; // Older
    const itemC: AggregatedItem = {
      id: 3,
      title: "C",
      url: null,
      by: "c",
      timeISO: "invalid-date",
    }; // Invalid

    const sorted = [itemC, itemB, itemA].sort(sortItemsDesc);
    expect(sorted.map((it) => it.title)).toEqual(["A", "B", "C"]);

    // Test deterministic sort for two invalid dates
    const itemD: AggregatedItem = {
      id: 4,
      title: "D",
      url: null,
      by: "d",
      timeISO: "invalid-date-2",
    };
    const sortedInvalid = [itemC, itemD].sort(sortItemsDesc);
    expect(sortedInvalid.map((it) => it.title)).toEqual(["D", "C"]); // by id desc
  });
});