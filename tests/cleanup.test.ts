import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

import { SCORE_MIN_CLEANUP } from "@config/constants";
import { writeJsonFile } from "@utils/json";
import { ensureDir } from "@utils/fs";
import { withTempDir, mockPaths } from "./helpers";

describe("scripts/cleanup", () => {
  test("removes low-score artifacts and prunes aggregated (negative)", async () => {
    const lowScoreId = SCORE_MIN_CLEANUP - 1;
    const keepScoreId = SCORE_MIN_CLEANUP;

    await withTempDir(async (base) => {
      const { PATHS, pathFor } = mockPaths(base);
      const { default: cleanupMain } = await import("@scripts/cleanup.mts");
      if (typeof cleanupMain !== "function") {
        throw new TypeError("Imported cleanupMain is not a function");
      }

      // Setup
      await ensureDir(dirname(pathFor.rawItem(1)));
      await ensureDir(dirname(pathFor.rawComments(1)));
      await ensureDir(dirname(pathFor.articleMd(1)));
      await ensureDir(dirname(pathFor.postSummary(1)));

      // Create files for low-score item
      const lowScoreStory = { id: lowScoreId, score: lowScoreId, title: "low" };
      await writeJsonFile(pathFor.rawItem(lowScoreId), lowScoreStory);
      await writeJsonFile(pathFor.rawComments(lowScoreId), []);
      await writeJsonFile(pathFor.articleMd(lowScoreId), "markdown");
      await writeJsonFile(pathFor.postSummary(lowScoreId), {});
      await writeJsonFile(pathFor.commentsSummary(lowScoreId), {});
      // tagsSummary intentionally absent

      // Create files for item to keep
      const keepScoreStory = { id: keepScoreId, score: keepScoreId, title: "keep" };
      await writeJsonFile(pathFor.rawItem(keepScoreId), keepScoreStory);

      // Create index file
      await writeJsonFile(PATHS.index, { storyIds: [lowScoreId, keepScoreId] });

      // Create aggregated file
      const aggregated = {
        items: [
          { id: lowScoreId, score: lowScoreId },
          { id: keepScoreId, score: keepScoreId },
        ],
      };
      await writeJsonFile(PATHS.aggregated, aggregated);

      // Run the script
      await cleanupMain();

      // Assertions
      // Low-score files should be removed
      expect(existsSync(pathFor.rawItem(lowScoreId))).toBe(false);
      expect(existsSync(pathFor.rawComments(lowScoreId))).toBe(false);
      expect(existsSync(pathFor.articleMd(lowScoreId))).toBe(false);
      expect(existsSync(pathFor.postSummary(lowScoreId))).toBe(false);
      expect(existsSync(pathFor.commentsSummary(lowScoreId))).toBe(false);

      // Kept files should remain
      expect(existsSync(pathFor.rawItem(keepScoreId))).toBe(true);

      // Aggregated file should be pruned
      const { readFile } = await import("node:fs/promises");
      const updated = JSON.parse(await readFile(PATHS.aggregated, "utf8"));
      expect(updated.items.length).toBe(1);
      expect(updated.items[0].id).toBe(keepScoreId);
    });
  });
});