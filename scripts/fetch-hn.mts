import { env, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import type { HnItemRaw, NormalizedComment, NormalizedStory } from "@config/schemas";
import { HnItemRawSchema } from "@config/schemas";
import { ensureDir } from "@utils/fs";
import { HttpClient } from "@utils/http-client";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { clamp, htmlToPlain } from "@utils/text";
import pLimit from "p-limit";
import { dirname } from "path";
import { z } from "zod";
import { HN } from "../utils/hn.js";

type Services = {
  http: HttpClient;
};

const SKIPPED_AUTHORS: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.protocol.startsWith("http")) return null;
    return u.toString();
  } catch {
    return null;
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
      ua: "hn-distill/1.0 (+https://github.com/hn-distill)",
      headers: {},
    }
  );
  return { http };
}

export async function readTopIds(services: Services, limit: number): Promise<number[]> {
  const ids = await services.http.json<number[]>(`${HN.api}/topstories.json`).catch(() => []);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  return ids.slice(0, Math.max(0, limit));
}

export async function fetchItem(services: Services, id: number): Promise<HnItemRaw | null> {
  const url = `${HN.api}/item/${id}.json`;
  try {
    const data = await services.http.json<unknown>(url);
    const parsed = HnItemRawSchema.safeParse(data);
    if (!parsed.success) return null;
    return parsed.data as HnItemRaw;
  } catch {
    return null;
  }
}

export function normalizeStory(raw: HnItemRaw): NormalizedStory {
  if (raw.type !== "story") {
    throw new Error(`Not a story: ${raw.id}`);
  }
  const title = clamp(raw.title ?? "(no title)", 500);
  const by = clamp(raw.by ?? "unknown", 80);
  const timeMs = Number.isFinite(raw.time) ? (raw.time as number) * 1000 : Date.now();
  return {
    id: raw.id,
    title,
    url: normalizeUrl(raw.url),
    by,
    timeISO: new Date(timeMs).toISOString(),
    commentIds: (raw.kids ?? []) as number[],
    score: raw.score ?? undefined,
    descendants: raw.descendants ?? undefined,
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

async function migrateCache(raw: any): Promise<CacheShape> {
  const migrated: CacheShape = {};
  for (const key in raw) {
    const storyId = Number(key);
    if (isNaN(storyId)) continue;
    const entry = raw[key];
    const seenTopLevel = entry.seenTopLevel ?? entry.seenKids ?? [];
    const seenByDepth = entry.seenByDepth ?? {};
    const updatedISO = entry.updatedISO ?? new Date(0).toISOString();
    migrated[storyId] = { seenTopLevel, seenByDepth, updatedISO };
  }
  return migrated;
}

async function readCache(): Promise<CacheShape> {
  const rawCache = await readJsonSafeOr<any>(PATHS.cache, z.any(), {});
  return migrateCache(rawCache);
}

export async function collectComments(
  services: Services,
  rootIds: number[],
  opts: {
    maxDepth: number;
    maxCount: number;
    concurrency: number;
    seenByDepth: Record<string, number[]>;
  }
): Promise<{ comments: NormalizedComment[]; allSeenByDepth: Record<number, number[]> }> {
  const limit = pLimit(opts.concurrency);
  const queue: Array<{ id: number; depth: number }> = rootIds.map((id) => ({
    id,
    depth: 1,
  }));
  const out: NormalizedComment[] = [];
  const visitedThisRun = new Set<number>();
  const allSeenByDepth: Record<number, number[]> = {};

  while (queue.length > 0 && out.length < opts.maxCount) {
    const batchSize = Math.max(1, Math.min(queue.length, opts.concurrency));
    const batch = queue.splice(0, batchSize);
    const results = await Promise.all(
      batch.map(({ id, depth }) =>
        limit(async () => {
          if (visitedThisRun.has(id)) return null;
          visitedThisRun.add(id);

          if (!allSeenByDepth[depth]) allSeenByDepth[depth] = [];
          allSeenByDepth[depth].push(id);

          const item = await fetchItem(services, id).catch(() => null);
          if (!item || item.type !== "comment") return null;

          const kids = Array.isArray(item.kids) ? item.kids : [];

          if (SKIPPED_AUTHORS.includes(item.by ?? "")) {
            return { normalized: null, kids, depthCurrent: depth, skip: true };
          }

          const textPlainRaw = htmlToPlain(item.text ?? "");
          if (!textPlainRaw) {
            return { normalized: null, kids, depthCurrent: depth, skip: true };
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
        })
      )
    );

    for (const res of results) {
      if (!res) continue;
      if (!res.skip && res.normalized && out.length < opts.maxCount) {
        out.push(res.normalized);
      }
      if (res.depthCurrent < opts.maxDepth) {
        const nextDepth = res.depthCurrent + 1;
        const seenAtNextDepth = opts.seenByDepth[String(nextDepth)] ?? [];
        for (const kid of res.kids) {
          if (out.length + queue.length >= opts.maxCount) break;
          if (seenAtNextDepth.includes(kid)) continue;
          if (!visitedThisRun.has(kid)) {
            queue.push({ id: kid, depth: nextDepth });
          }
        }
      }
    }

    await sleep(5);
  }

  return { comments: out.slice(0, opts.maxCount), allSeenByDepth };
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
    topIds.map((id) =>
      limit(async () => {
        const item = await fetchItem(services, id);
        if (!item) return;
        if (item.type !== "story") return;
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
          for (const [depth, arr] of Object.entries(allSeenByDepth)) {
            c[String(depth)] = Array.from(new Set(arr));
          }
          cache[story.id] = {
            seenTopLevel: Array.from(new Set(rootIds)),
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
    storyIds: Array.from(idsSet),
  };
  await writeJsonFile(PATHS.index, index, { atomic: true, pretty: true });

  await writeJsonFile(PATHS.cache, cache, { atomic: true, pretty: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
