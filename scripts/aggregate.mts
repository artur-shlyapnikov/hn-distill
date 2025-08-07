import { env, type Env } from "@config/env";
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
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";
import { formatISO } from "date-fns";
import { HN } from "../utils/hn.js";

type Services = {
  noop?: true;
};

export function makeServices(_env: Env): Services {
  return {};
}

export async function readAggregates(storyIds: number[]): Promise<AggregatedItem[]> {
  const items: AggregatedItem[] = [];
  for (const id of storyIds) {
    log.debug("aggregate", "Aggregating story", { id });
    const story = await readJsonSafeOr(pathFor.rawItem(id), NormalizedStorySchema.nullable(), null);
    if (!story) {
      log.warn("aggregate", "Missing story; skipping", { id });
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

async function main(): Promise<void> {
  const _services = makeServices(env);

  const index = await readJsonSafeOr<{ updatedISO: string; storyIds: number[] }>(PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const prev = await readJsonSafeOr<AggregatedFile>(PATHS.aggregated, AggregatedFileSchema, {
    updatedISO: new Date(0).toISOString(),
    items: [],
  });

  const items = await readAggregates(index.storyIds);
  const useItems = items.length > 0 ? items : Array.isArray(prev.items) ? prev.items : [];

  const safeItems = Array.isArray(useItems)
    ? useItems.filter((it) => {
        try {
          AggregatedItemSchema.parse(it);
          return true;
        } catch (e) {
          log.warn("aggregate", "Dropping invalid item during validation", { error: String(e) });
          return false;
        }
      })
    : [];

  const payload: AggregatedFile = {
    updatedISO: formatISO(new Date()),
    items: safeItems,
  };
  await writeJsonFile(PATHS.aggregated, payload, { atomic: true, pretty: true });
  log.info("aggregate", "Aggregated file written", { path: PATHS.aggregated, items: payload.items.length });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
