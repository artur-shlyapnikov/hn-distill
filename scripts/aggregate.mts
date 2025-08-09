import { type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import type { AggregatedFile, AggregatedItem, NormalizedComment, NormalizedStory } from "@config/schemas";
import {
  AggregatedFileSchema,
  AggregatedItemSchema,
  CommentsSummarySchema,
  IndexSchema,
  NormalizedCommentSchema,
  NormalizedStorySchema,
  PostSummarySchema,
} from "@config/schemas";
import { ensureDir } from "@utils/fs";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";
import { formatISO } from "date-fns";
import { dirname } from "path";
import { HN } from "../utils/hn.js";

type Services = {
  noop?: true;
};

export function makeServices(_env: Env): Services {
  return {};
}

const SCORE_MIN = 75;

export async function readAggregates(storyIds: number[]): Promise<AggregatedItem[]> {
  const items: AggregatedItem[] = [];
  for (const id of storyIds) {
    log.debug("aggregate", "Aggregating story", { id });
    const story = await readJsonSafeOr(pathFor.rawItem(id), NormalizedStorySchema.nullable(), null);
    if (!story) {
      log.warn("aggregate", "Missing story; skipping", { id });
      continue;
    }

    // filter out low-score stories entirely
    const score = typeof story.score === "number" ? story.score : 0;
    if (score < SCORE_MIN) {
      log.debug("aggregate", "Skipping story due to low score", { id, score, min: SCORE_MIN });
      continue;
    }

    const comments = await readJsonSafeOr<NormalizedComment[]>(
      pathFor.rawComments(id),
      NormalizedCommentSchema.array(),
      []
    );

    const postSummary = await readJsonSafeOr(pathFor.postSummary(id), PostSummarySchema.nullable(), null);
    const commentsSummary = await readJsonSafeOr(pathFor.commentsSummary(id), CommentsSummarySchema.nullable(), null);
    const fb = fallbackFromRaw(story, comments);

    let domain: string | undefined;
    if (story.url) {
      try {
        domain = new URL(story.url).hostname.replace(/^www\./, "");
      } catch {
        // ignore URL parse errors
      }
    }

    const item: AggregatedItem = {
      id: story.id,
      title: story.title,
      url: story.url,
      by: story.by,
      timeISO: story.timeISO,
      postSummary: postSummary?.summary ?? undefined,
      commentsSummary: commentsSummary?.summary ?? fb.commentsSummary ?? undefined,
      score: story.score ?? undefined,
      commentsCount: story.descendants ?? comments.length ?? undefined,
      hnUrl: HN.itemUrl(story.id),
      domain,
    };
    if (!item.postSummary) {
      log.info("aggregate", "No postSummary for story (will render placeholder)", { id: story.id });
    }
    items.push(item);
  }
  return items;
}

export function fallbackFromRaw(
  _story: NormalizedStory,
  comments: NormalizedComment[]
): { postSummary?: string | undefined; commentsSummary?: string | undefined } {
  const combined = comments
    .map((c) => c.textPlain)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const commentsSummary: string | undefined = combined ? combined.slice(0, 280) : undefined;
  return { postSummary: undefined, commentsSummary };
}

function sortItemsDesc(a: AggregatedItem, b: AggregatedItem): number {
  const ta = Date.parse((a as any).timeISO ?? "");
  const tb = Date.parse((b as any).timeISO ?? "");
  const aHas = Number.isFinite(ta);
  const bHas = Number.isFinite(tb);
  if (aHas && bHas) return tb - ta;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  return (b.id ?? 0) - (a.id ?? 0);
}

async function main(): Promise<void> {
  const index = await readJsonSafeOr<{ updatedISO: string; storyIds: number[] }>(PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const prev = await readJsonSafeOr<AggregatedFile>(PATHS.aggregated, AggregatedFileSchema, {
    updatedISO: new Date(0).toISOString(),
    items: [],
  });

  const newItems = await readAggregates(index.storyIds);

  // merge with previous: previous first, then overwrite with new by id
  const byId = new Map<number, AggregatedItem>();
  for (const it of prev.items ?? []) byId.set(it.id, it);
  for (const it of newItems) byId.set(it.id, it);

  // optional purge of low-score items from history to keep it consistent with the rule
  // simplicity: keep also enforcing score >= SCORE_MIN on merged output
  const merged = Array.from(byId.values()).filter((it) => {
    const s = typeof it.score === "number" ? it.score : 0;
    return s >= SCORE_MIN;
  });

  const sorted = merged.sort(sortItemsDesc);

  const safeItems = sorted.filter((it) => {
    try {
      AggregatedItemSchema.parse(it);
      return true;
    } catch (e) {
      log.warn("aggregate", "Dropping invalid item during validation", { id: (it as any)?.id, error: String(e) });
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
    added: newItems.length,
    prev: prev.items.length,
  });

  // Additional grouped outputs for historical slices
  try {
    const items = payload.items;
    const byDay: Record<string, number[]> = {};
    const byWeek: Record<string, number[]> = {};
    function dayKey(iso: string): string {
      return iso.slice(0, 10);
    }
    function isoWeekKey(iso: string): string {
      const d = new Date(iso);
      const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dayNum = dt.getUTCDay() || 7;
      dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((dt as any) - (yearStart as any)) / 86400000 + 1) / 7);
      const w = String(weekNo).padStart(2, "0");
      return `${dt.getUTCFullYear()}-w${w}`;
    }
    for (const it of items) {
      const dkey = dayKey(it.timeISO);
      const wkey = isoWeekKey(it.timeISO);
      (byDay[dkey] ??= []).push(it.id);
      (byWeek[wkey] ??= []).push(it.id);
    }
    await ensureDir(dirname(PATHS.grouped.daily));
    await writeJsonFile(
      PATHS.grouped.daily,
      { updatedISO: payload.updatedISO, byDate: byDay },
      { atomic: true, pretty: true }
    );
    await writeJsonFile(
      PATHS.grouped.weekly,
      { updatedISO: payload.updatedISO, byWeek: byWeek },
      { atomic: true, pretty: true }
    );
    log.info("aggregate", "Grouped files written", {
      daily: PATHS.grouped.daily,
      weekly: PATHS.grouped.weekly,
      days: Object.keys(byDay).length,
      weeks: Object.keys(byWeek).length,
    });
  } catch (e) {
    log.warn("aggregate", "Failed to write grouped files", { error: String(e) });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
