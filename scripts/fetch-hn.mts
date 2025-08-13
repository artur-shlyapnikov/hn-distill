import { dirname } from "node:path";

import pLimit from "p-limit";
import { z } from "zod";

import { env, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import { HnItemRawSchema } from "@config/schemas";
import { ensureDir } from "@utils/fs";
import { HttpClient } from "@utils/http-client";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { clamp, htmlToPlain } from "@utils/text";

import { HN } from "../utils/hn.js";

import type { HnItemRaw, NormalizedComment, NormalizedStory } from "@config/schemas";

type Services = {
  http: HttpClient;
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith("http")) {
      return undefined;
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

export function makeServices(e: Env): Services {
  const http = new HttpClient(
    {
      retries: e.HTTP_RETRIES,
      baseBackoffMs: e.HTTP_BACKOFF_MS,
      timeoutMs: e.HTTP_TIMEOUT_MS,
      retryOnStatuses: [408, 425, 429, 500, 502, 503, 504, 522],
    },
    {
      ua: "hckr.top/1.0 (+https://hckr.top)",
      headers: {},
    }
  );
  return { http };
}

export async function readTopIds(services: Services, limit: number): Promise<number[]> {
  const ids = await services.http.json<number[]>(`${HN.api}/topstories.json`).catch(() => []);
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  return ids.slice(0, Math.max(0, limit));
}

export async function fetchItem(services: Services, id: number): Promise<HnItemRaw | undefined> {
  const url = `${HN.api}/item/${id}.json`;
  try {
    const data = await services.http.json<unknown>(url);
    const parsed = HnItemRawSchema.safeParse(data);
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

export function normalizeStory(raw: HnItemRaw): NormalizedStory {
  if (raw.type !== "story") {
    throw new Error(`Not a story: ${raw.id}`);
  }
  const title = clamp(raw.title ?? "(no title)", 500);
  const by = clamp(raw.by ?? "unknown", 80);
  const timeMs = Number.isFinite(raw.time) ? raw.time * 1000 : Date.now();
  return {
    id: raw.id,
    title,
    url: normalizeUrl(raw.url),
    by,
    timeISO: new Date(timeMs).toISOString(),
    commentIds: raw.kids ?? [],
    score: raw.score,
    descendants: raw.descendants,
  };
}

type CacheShape = Record<
  number,
  {
    seenTopLevel: number[];
    seenByDepth: Record<string, number[]>;
    updatedISO: string;
  }
>;

async function migrateCache(raw: unknown): Promise<CacheShape> {
  const migrated: CacheShape = {};
  if (typeof raw !== "object" || raw === null) {
    return migrated;
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const storyId = Number(key);
    if (Number.isNaN(storyId)) {
      continue;
    }
    const entry = (raw as Record<string, unknown>)[key] as
      | {
          seenTopLevel?: number[];
          seenKids?: number[];
          seenByDepth?: Record<string, number[]>;
          updatedISO?: string;
        }
      | undefined;
    const seenTopLevel: number[] = entry?.seenTopLevel ?? entry?.seenKids ?? [];
    const seenByDepth: Record<string, number[]> = entry?.seenByDepth ?? {};
    const updatedISO: string = typeof entry?.updatedISO === "string" ? entry.updatedISO : new Date(0).toISOString();
    migrated[storyId] = { seenTopLevel, seenByDepth, updatedISO };
  }
  return migrated;
}

async function readCache(): Promise<CacheShape> {
  const rawCache = await readJsonSafeOr<Record<string, unknown>>(PATHS.cache, z.record(z.unknown()), {});
  return migrateCache(rawCache);
}

type CommentFetchResult = {
  normalized?: NormalizedComment;
  kids: number[];
  depthCurrent: number;
  skip: boolean;
};

async function processCommentItem(
  services: Services,
  id: number,
  depth: number,
  visitedThisRun: Set<number>,
  allSeenByDepth: Record<number, number[]>
): Promise<CommentFetchResult | undefined> {
  if (visitedThisRun.has(id)) {
    return;
  }
  visitedThisRun.add(id);

  allSeenByDepth[depth] ??= [];
  allSeenByDepth[depth].push(id);

  const item = await fetchItem(services, id).catch(() => {
    // Ignore fetch errors and continue
  });
  if (!item || item.type !== "comment") {
    return;
  }

  const kids = Array.isArray(item.kids) ? item.kids : [];

  const textPlainRaw = htmlToPlain(item.text ?? "");
  if (!textPlainRaw) {
    return { normalized: undefined, kids, depthCurrent: depth, skip: true };
  }
  const textPlain = clamp(textPlainRaw, env.MAX_BODY_CHARS);
  const normalized: NormalizedComment = {
    id: item.id,
    by: clamp(item.by ?? "unknown", 80),
    timeISO: new Date((Number.isFinite(item.time) ? item.time : Date.now() / 1000) * 1000).toISOString(),
    textPlain,
    parent: item.parent ?? 0,
    depth,
  };
  return { normalized, kids, depthCurrent: depth, skip: false };
}

function addKidsToQueue(
  result: CommentFetchResult,
  queue: Array<{ id: number; depth: number }>,
  options: {
    maxDepth: number;
    maxCount: number;
    seenByDepth: Record<string, number[]>;
  },
  visitedThisRun: Set<number>,
  currentCount: number
): void {
  if (result.depthCurrent >= options.maxDepth) {
    return;
  }

  const nextDepth = result.depthCurrent + 1;
  const seenAtNextDepth = options.seenByDepth[String(nextDepth)] ?? [];
  for (const kid of result.kids) {
    if (currentCount + queue.length >= options.maxCount) {
      break;
    }
    if (seenAtNextDepth.includes(kid)) {
      continue;
    }
    if (!visitedThisRun.has(kid)) {
      queue.push({ id: kid, depth: nextDepth });
    }
  }
}

export async function collectComments(
  services: Services,
  rootIds: number[],
  options: {
    maxDepth: number;
    maxCount: number;
    concurrency: number;
    seenByDepth: Record<string, number[]>;
  }
): Promise<{ comments: NormalizedComment[]; allSeenByDepth: Record<number, number[]> }> {
  const limit = pLimit(options.concurrency);
  const queue: Array<{ id: number; depth: number }> = rootIds.map((id) => ({
    id,
    depth: 1,
  }));
  const out: NormalizedComment[] = [];
  const visitedThisRun = new Set<number>();
  const allSeenByDepth: Record<number, number[]> = {};

  while (queue.length > 0 && out.length < options.maxCount) {
    const batchSize = Math.max(1, Math.min(queue.length, options.concurrency));
    const batch = queue.splice(0, batchSize);
    const results = await Promise.all(
      batch.map(async ({ id, depth }) =>
        limit(async () => processCommentItem(services, id, depth, visitedThisRun, allSeenByDepth))
      )
    );

    for (const res of results) {
      if (!res) {
        continue;
      }
      if (!res.skip && res.normalized && out.length < options.maxCount) {
        out.push(res.normalized);
      }
      addKidsToQueue(res, queue, options, visitedThisRun, out.length);
    }

    await sleep(5);
  }

  return { comments: out.slice(0, options.maxCount), allSeenByDepth };
}

async function main(): Promise<void> {
  const services = makeServices(env);

  await ensureDir(PATHS.raw.items);
  await ensureDir(PATHS.raw.comments);
  await ensureDir(dirname(PATHS.index));
  await ensureDir(dirname(PATHS.cache));

  const cache = await readCache();

  const topIds = await readTopIds(services, env.TOP_N);
  const idsSet = new Set<number>(topIds);

  const concurrency = Math.max(1, env.CONCURRENCY);
  const limit = pLimit(concurrency);

  const stories: NormalizedStory[] = [];
  const commentsByStory: Record<number, NormalizedComment[]> = {};

  await Promise.all(
    topIds.map(async (id) =>
      limit(async () => {
        const item = await fetchItem(services, id);
        if (!item) {
          return;
        }
        if (item.type !== "story") {
          return;
        }
        const story = normalizeStory(item);
        stories.push(story);

        const entry = cache[story.id];
        const seenByDepth = entry?.seenByDepth ?? {};
        const rootIds = Array.isArray(story.commentIds) ? story.commentIds : [];

        if (rootIds.length > 0) {
          const { comments, allSeenByDepth } = await collectComments(services, rootIds, {
            maxDepth: env.MAX_DEPTH,
            maxCount: env.MAX_COMMENTS_PER_STORY,
            concurrency,
            seenByDepth,
          });
          commentsByStory[story.id] = comments;

          const c: Record<string, number[]> = {};
          for (const [depth, array] of Object.entries(allSeenByDepth)) {
            c[String(depth)] = [...new Set(array)];
          }
          cache[story.id] = {
            seenTopLevel: [...new Set(rootIds)],
            seenByDepth: c,
            updatedISO: new Date().toISOString(),
          };
        }
      })
    )
  );

  for (const s of stories) {
    await writeJsonFile(pathFor.rawItem(s.id), s, { atomic: true, pretty: true });
    const comments = commentsByStory[s.id] ?? [];
    await writeJsonFile(pathFor.rawComments(s.id), comments, { atomic: true, pretty: true });
  }

  const index = {
    updatedISO: new Date().toISOString(),
    storyIds: [...idsSet],
  };
  await writeJsonFile(PATHS.index, index, { atomic: true, pretty: true });

  await writeJsonFile(PATHS.cache, cache, { atomic: true, pretty: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
