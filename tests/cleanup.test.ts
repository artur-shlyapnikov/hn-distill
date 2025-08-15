import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

import { SCORE_MIN_CLEANUP } from "@config/constants";
import { writeJsonFile } from "@utils/json";
import { ensureDir } from "@utils/fs";

// Mock PATHS before importing the script
let tmpDir: string;

type TmpPathsType = {
  dataDir: string;
  raw: { items: string; comments: string; articles: string };
  summaries: string;
  index: string;
  aggregated: string;
};
type TmpPathForType = {
  rawItem: (id: number) => string;
  rawComments: (id: number) => string;
  articleMd: (id: number) => string;
  postSummary: (id: number) => string;
  commentsSummary: (id: number) => string;
  tagsSummary: (id: number) => string;
};

let TmpPATHS: TmpPathsType;
let TmpPathFor: TmpPathForType;

const lowScoreId = SCORE_MIN_CLEANUP - 1;
const keepScoreId = SCORE_MIN_CLEANUP;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cleanup-test-"));
  TmpPATHS = {
    dataDir: tmpDir,
    raw: {
      items: join(tmpDir, "raw", "items"),
      comments: join(tmpDir, "raw", "comments"),
      articles: join(tmpDir, "raw", "articles"),
    },
    summaries: join(tmpDir, "summaries"),
    index: join(tmpDir, "index.json"),
    aggregated: join(tmpDir, "aggregated.json"),
  };
  TmpPathFor = {
    rawItem: (id: number) => join(TmpPATHS.raw.items, `${id}.json`),
    rawComments: (id: number) => join(TmpPATHS.raw.comments, `${id}.json`),
    articleMd: (id: number) => join(TmpPATHS.raw.articles, `${id}.md`),
    postSummary: (id: number) => join(TmpPATHS.summaries, `${id}.post.json`),
    commentsSummary: (id: number) => join(TmpPATHS.summaries, `${id}.comments.json`),
    tagsSummary: (id: number) => join(TmpPATHS.summaries, `${id}.tags.json`),
  };

  mock.module("@config/paths", () => ({
    PATHS: TmpPATHS,
    pathFor: TmpPathFor,
  }));
});

afterAll(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

describe("scripts/cleanup", () => {
  test("32. cleanup removes low-score artifacts and prunes aggregated (negative)", async () => {
    // Setup
    await ensureDir(dirname(TmpPathFor.rawItem(1)));
    await ensureDir(dirname(TmpPathFor.rawComments(1)));
    await ensureDir(dirname(TmpPathFor.articleMd(1)));
    await ensureDir(dirname(TmpPathFor.postSummary(1)));

    // Create files for low-score item
    const lowScoreStory = { id: lowScoreId, score: lowScoreId, title: "low" };
    await writeJsonFile(TmpPathFor.rawItem(lowScoreId), lowScoreStory);
    await writeJsonFile(TmpPathFor.rawComments(lowScoreId), []);
    await writeJsonFile(TmpPathFor.articleMd(lowScoreId), "markdown");
    await writeJsonFile(TmpPathFor.postSummary(lowScoreId), {});
    await writeJsonFile(TmpPathFor.commentsSummary(lowScoreId), {});
    // tagsSummary is one we'll pretend is already missing
    // await writeJsonFile(TmpPathFor.tagsSummary(lowScoreId), {});

    // Create files for item to keep
    const keepScoreStory = { id: keepScoreId, score: keepScoreId, title: "keep" };
    await writeJsonFile(TmpPathFor.rawItem(keepScoreId), keepScoreStory);

    // Create index file
    await writeJsonFile(TmpPATHS.index, { storyIds: [lowScoreId, keepScoreId] });

    // Create aggregated file
    const aggregated = {
      items: [
        { id: lowScoreId, score: lowScoreId },
        { id: keepScoreId, score: keepScoreId },
      ],
    };
    await writeJsonFile(TmpPATHS.aggregated, aggregated);

    // Dynamically import the main function to use the mocked paths
    const { default: cleanupMain } = await import("@scripts/cleanup.mts");

    // Run the script
    if (typeof cleanupMain !== "function") {
      throw new TypeError("Imported cleanupMain is not a function");
    }
    await cleanupMain();

    // Assertions
    // Low-score files should be removed
    expect(existsSync(TmpPathFor.rawItem(lowScoreId))).toBe(false);
    expect(existsSync(TmpPathFor.rawComments(lowScoreId))).toBe(false);
    expect(existsSync(TmpPathFor.articleMd(lowScoreId))).toBe(false);
    expect(existsSync(TmpPathFor.postSummary(lowScoreId))).toBe(false);
    expect(existsSync(TmpPathFor.commentsSummary(lowScoreId))).toBe(false);

    // Kept files should remain
    expect(existsSync(TmpPathFor.rawItem(keepScoreId))).toBe(true);

    // Aggregated file should be pruned
    const { readFile } = await import("node:fs/promises");
    const updated = JSON.parse(await readFile(TmpPATHS.aggregated, "utf8"));
    expect(updated.items.length).toBe(1);
    expect(updated.items[0].id).toBe(keepScoreId);
  });
});