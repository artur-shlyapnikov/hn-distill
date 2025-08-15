import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hn-distill-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function makeTmpPATHS(base: string) {
  return {
    dataDir: base,
    raw: {
      items: join(base, "raw", "items"),
      comments: join(base, "raw", "comments"),
      articles: join(base, "raw", "articles"),
    },
    summaries: join(base, "summaries"),
    index: join(base, "index.json"),
    aggregated: join(base, "aggregated.json"),
  };
}

export function makeTmpPathFor(PATHS: ReturnType<typeof makeTmpPATHS>) {
  return {
    rawItem: (id: number) => join(PATHS.raw.items, `${id}.json`),
    rawComments: (id: number) => join(PATHS.raw.comments, `${id}.json`),
    articleMd: (id: number) => join(PATHS.raw.articles, `${id}.md`),
    postSummary: (id: number) => join(PATHS.summaries, `${id}.post.json`),
    commentsSummary: (id: number) => join(PATHS.summaries, `${id}.comments.json`),
    tagsSummary: (id: number) => join(PATHS.summaries, `${id}.tags.json`),
  };
}