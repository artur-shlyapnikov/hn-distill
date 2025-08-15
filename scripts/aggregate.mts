import { dirname } from "node:path";

import { formatISO } from "date-fns";
import { z } from "zod";

import { SCORE_MIN_AGGREGATE } from "@config/constants";
import { PATHS, pathFor } from "@config/paths";
import {
  AggregatedFileSchema,
  AggregatedItemSchema,
  CommentsSummarySchema,
  IndexSchema,
  NormalizedCommentSchema,
  PostSummarySchema,
  TagsSummarySchema,
  type AggregatedFile,
  type AggregatedItem,
  type NormalizedComment,
  type NormalizedStory,
} from "@config/schemas";
import { isoWeekKey, toDateKeyUTC } from "@utils/date-keys";
import { ensureDir } from "@utils/fs";
import { HN } from "@utils/hn";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";

type Services = {
  noop?: true;
};

export function makeServices(): Services {
  return {};
}

async function loadStoryData(id: number): Promise<{
  story: NormalizedStory | undefined;
  comments: NormalizedComment[];
  postSummary: unknown;
  commentsSummary: unknown;
  tagsSummary: unknown;
}> {
  // Relaxed schema sufficient for aggregation; matches what tests write.
  const AggregationStorySchema = z.object({
    id: z.number(),
    title: z.string(),
    // Explicitly allow null and use null as a fallback default for invalid values.
    // eslint-disable-next-line unicorn/no-null
    url: z.union([z.string(), z.null()]).optional().catch(null),
    by: z.string(),
    timeISO: z.string(), // accept any string; invalid dates handled later
    score: z.number().optional(),
    descendants: z.number().optional(),
    // commentIds not required for aggregation
  });

  const storyLoose = await readJsonSafeOr(pathFor.rawItem(id), AggregationStorySchema.nullable());
  if (!storyLoose) {
    return {
      story: undefined,
      comments: [],
      postSummary: undefined,
      commentsSummary: undefined,
      tagsSummary: undefined,
    };
  }

  // Cast to NormalizedStory for downstream use; fields we read are present.
  const story = storyLoose as unknown as NormalizedStory;

  const [comments, postSummary, commentsSummary, tagsSummary] = await Promise.all([
    readJsonSafeOr<NormalizedComment[]>(pathFor.rawComments(id), NormalizedCommentSchema.array(), []),
    readJsonSafeOr(pathFor.postSummary(id), PostSummarySchema.nullable()),
    readJsonSafeOr(pathFor.commentsSummary(id), CommentsSummarySchema.nullable()),
    readJsonSafeOr(pathFor.tagsSummary(id), TagsSummarySchema.nullable()),
  ]);

  return { story, comments, postSummary, commentsSummary, tagsSummary };
}

export function extractDomain(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

export function buildAggregatedItem(
  story: NormalizedStory,
  comments: NormalizedComment[],
  postSummary: unknown,
  commentsSummary: unknown,
  tagsSummary: unknown
): AggregatedItem {
  const fb = fallbackFromRaw(story, comments);
  const domain = extractDomain(story.url ?? undefined);
  const rawTags = ((tagsSummary as { tags?: Array<{ name: string }> } | undefined)?.tags ?? []).map(
    (t: { name: string }) => t.name
  );
  const tags = [...new Set(rawTags)];

  return {
    id: story.id,
    title: story.title,
    url: story.url,
    by: story.by,
    timeISO: story.timeISO,
    postSummary: (postSummary as { summary?: string } | undefined)?.summary,
    commentsSummary: (commentsSummary as { summary?: string } | undefined)?.summary ?? fb.commentsSummary,
    score: story.score,
    commentsCount: story.descendants ?? comments.length,
    hnUrl: HN.itemUrl(story.id),
    domain,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export async function readAggregates(storyIds: number[]): Promise<AggregatedItem[]> {
  const items: AggregatedItem[] = [];

  for (const id of storyIds) {
    log.debug("aggregate", "Aggregating story", { id });

    const { story, comments, postSummary, commentsSummary, tagsSummary } = await loadStoryData(id);
    if (!story) {
      log.warn("aggregate", "Missing story; skipping", { id });
      continue;
    }

    const score = typeof story.score === "number" ? story.score : 0;
    if (score < SCORE_MIN_AGGREGATE) {
      log.debug("aggregate", "Skipping story due to low score", { id, score, min: SCORE_MIN_AGGREGATE });
      continue;
    }

    const item = buildAggregatedItem(story, comments, postSummary, commentsSummary, tagsSummary);
    if (!item.postSummary) {
      log.info("aggregate", "No postSummary for story (will render placeholder)", { id: story.id });
    }
    items.push(item);
  }
  return items;
}

const FALLBACK_SUMMARY_LENGTH = 280;

export function fallbackFromRaw(
  _story: NormalizedStory,
  comments: NormalizedComment[]
): { postSummary?: string | undefined; commentsSummary?: string | undefined } {
  const combined = comments
    .map((c) => c.textPlain)
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const commentsSummary: string | undefined = combined ? combined.slice(0, FALLBACK_SUMMARY_LENGTH) : undefined;
  return { postSummary: undefined, commentsSummary };
}

function parseIsoSafe(iso?: string): number {
  if (typeof iso !== "string") {
    return Number.NaN;
  }
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

export function sortItemsDesc(a: AggregatedItem, b: AggregatedItem): number {
  const ta = parseIsoSafe(a.timeISO);
  const tb = parseIsoSafe(b.timeISO);
  const aHas = Number.isFinite(ta);
  const bHas = Number.isFinite(tb);
  if (aHas && bHas) {
    return tb - ta; // newer first
  }
  if (aHas && !bHas) {
    return -1; // valid dates before invalid
  }
  if (!aHas && bHas) {
    return 1;
  }
  return b.id - a.id; // deterministic for both invalid: by id desc
}

async function main(): Promise<void> {
  const index = await readJsonSafeOr<{ updatedISO: string; storyIds: number[] }>(PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const previous = await readJsonSafeOr<AggregatedFile>(PATHS.aggregated, AggregatedFileSchema, {
    updatedISO: new Date(0).toISOString(),
    items: [],
  });

  const latestItems = await readAggregates(index.storyIds);

  // merge with previous: previous first, then overwrite with new by id
  const byId = new Map<number, AggregatedItem>();
  for (const it of previous.items) {
    byId.set(it.id, it);
  }
  for (const it of latestItems) {
    byId.set(it.id, it);
  }

  // optional purge of low-score items from history to keep it consistent with the rule
  // simplicity: keep also enforcing score >= SCORE_MIN on merged output
  const merged = [...byId.values()].filter((it) => {
    const s = typeof it.score === "number" ? it.score : 0;
    return s >= SCORE_MIN_AGGREGATE;
  });

  const sorted = merged.sort(sortItemsDesc);

  const safeItems = sorted.filter((it) => {
    try {
      AggregatedItemSchema.parse(it);
      return true;
    } catch (error) {
      log.warn("aggregate", "Dropping invalid item during validation", {
        id: (it as { id?: number }).id,
        error: String(error),
      });
      return false;
    }
  });

  const payload: AggregatedFile = {
    updatedISO: formatISO(new Date()),
    items: safeItems,
  };
  await writeJsonFile(PATHS.aggregated, payload, { atomic: true, pretty: true });
  log.info("aggregate", "Aggregated file written", {
    path: PATHS.aggregated,
    items: payload.items.length,
    added: latestItems.length,
    prev: previous.items.length,
  });

  // Additional grouped outputs for historical slices
  try {
    const { items, updatedISO } = payload;
    const byDay: Record<string, number[]> = {};
    const byWeek: Record<string, number[]> = {};

    for (const it of items) {
      const dkey = toDateKeyUTC(it.timeISO);
      const wkey = isoWeekKey(it.timeISO);
      (byDay[dkey] ??= []).push(it.id);
      (byWeek[wkey] ??= []).push(it.id);
    }
    await ensureDir(dirname(PATHS.grouped.daily));
    await writeJsonFile(PATHS.grouped.daily, { updatedISO, byDate: byDay }, { atomic: true, pretty: true });
    await writeJsonFile(PATHS.grouped.weekly, { updatedISO, byWeek }, { atomic: true, pretty: true });
    log.info("aggregate", "Grouped files written", {
      daily: PATHS.grouped.daily,
      weekly: PATHS.grouped.weekly,
      days: Object.keys(byDay).length,
      weeks: Object.keys(byWeek).length,
    });
  } catch (error) {
    log.warn("aggregate", "Failed to write grouped files", { error: String(error) });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
