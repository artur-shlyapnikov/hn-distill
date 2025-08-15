#!/usr/bin/env bun
import { rm } from "node:fs/promises";

import { z } from "zod";

import { SCORE_MIN_CLEANUP } from "@config/constants";
import { PATHS, pathFor } from "@config/paths";
import { NormalizedStorySchema } from "@config/schemas";
import { ensureDir, exists } from "@utils/fs";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";

async function safeRm(p: string): Promise<void> {
  if (await exists(p)) {
    await rm(p, { force: true });
    log.info("cleanup", "deleted", { path: p });
  }
}

async function main(): Promise<void> {
  await ensureDir(PATHS.dataDir);

  // Read index leniently: tests may omit updatedISO and only include storyIds
  const indexRaw = await readJsonSafeOr<Record<string, unknown>>(PATHS.index, z.record(z.unknown()), {});
  const storyIds: number[] = Array.isArray(indexRaw["storyIds"])
    ? (indexRaw["storyIds"] as unknown[]).filter((n): n is number => typeof n === "number")
    : [];

  const toDelete: number[] = [];

  for (const id of storyIds) {
    const storyScore = await readJsonSafeOr(
      pathFor.rawItem(id),
      z.object({ score: z.number().optional() }).nullable()
    );
    const score = typeof storyScore?.score === "number" ? storyScore.score : 0;
    if (score < SCORE_MIN_CLEANUP) {
      toDelete.push(id);
    }
  }

  log.info("cleanup", "low-score stories to delete", {
    count: toDelete.length,
    min: SCORE_MIN_CLEANUP,
  });

  for (const id of toDelete) {
    await safeRm(pathFor.rawItem(id));
    await safeRm(pathFor.rawComments(id));
    await safeRm(pathFor.articleMd(id));
    await safeRm(pathFor.postSummary(id));
    await safeRm(pathFor.commentsSummary(id));
    await safeRm(pathFor.tagsSummary(id));
  }

  // Update aggregated.json to remove deleted ids if present (be tolerant of minimal shape)
  const aggregatedRaw = await readJsonSafeOr<Record<string, unknown>>(PATHS.aggregated, z.record(z.unknown()), {});
  const itemsArray = Array.isArray(aggregatedRaw["items"]) ? (aggregatedRaw["items"] as unknown[]) : [];
  const before = itemsArray.length;
  const afterItems = itemsArray.filter((it) => !toDelete.includes((it as { id?: number }).id ?? -1));

  if (afterItems.length === before) {
    log.info("cleanup", "aggregated unchanged", { items: before });
  } else {
    const next = {
      ...aggregatedRaw,
      items: afterItems,
    };
    await writeJsonFile(PATHS.aggregated, next, { atomic: true, pretty: true });
    log.info("cleanup", "aggregated updated", {
      removed: before - afterItems.length,
      left: afterItems.length,
    });
  }
}

export default main;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
