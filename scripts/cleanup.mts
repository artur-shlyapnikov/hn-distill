#!/usr/bin/env bun
import { PATHS, pathFor } from "@config/paths";
import {
  IndexSchema,
  NormalizedStorySchema,
  AggregatedFileSchema,
  type AggregatedFile,
} from "@config/schemas";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { exists, ensureDir } from "@utils/fs";
import { rm } from "node:fs/promises";
import { log } from "@utils/log";

const SCORE_MIN = 50;

async function safeRm(p: string): Promise<void> {
  if (await exists(p)) {
    await rm(p, { force: true });
    log.info("cleanup", "deleted", { path: p });
  }
}

async function main(): Promise<void> {
  await ensureDir(PATHS.dataDir);

  const index = await readJsonSafeOr(PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const toDelete: number[] = [];
  for (const id of index.storyIds) {
    const story = await readJsonSafeOr(
      pathFor.rawItem(id),
      NormalizedStorySchema.nullable(),
      null
    );
    const score = typeof story?.score === "number" ? story.score! : 0;
    if (score < SCORE_MIN) {
      toDelete.push(id);
    }
  }

  log.info("cleanup", "low-score stories to delete", {
    count: toDelete.length,
    min: SCORE_MIN,
  });

  for (const id of toDelete) {
    await safeRm(pathFor.rawItem(id));
    await safeRm(pathFor.rawComments(id));
    await safeRm(pathFor.articleMd(id));
    await safeRm(pathFor.postSummary(id));
    await safeRm(pathFor.commentsSummary(id));
  }

  // Update aggregated.json to remove deleted ids if present
  const aggregated = await readJsonSafeOr<AggregatedFile>(
    PATHS.aggregated,
    AggregatedFileSchema,
    {
      updatedISO: new Date(0).toISOString(),
      items: [],
    }
  );

  const before = aggregated.items.length;
  const afterItems = aggregated.items.filter((it) => !toDelete.includes(it.id));
  if (afterItems.length !== before) {
    const next: AggregatedFile = {
      ...aggregated,
      items: afterItems,
    };
    await writeJsonFile(PATHS.aggregated, next, { atomic: true, pretty: true });
    log.info("cleanup", "aggregated updated", {
      removed: before - afterItems.length,
      left: afterItems.length,
    });
  } else {
    log.info("cleanup", "aggregated unchanged", { items: before });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}