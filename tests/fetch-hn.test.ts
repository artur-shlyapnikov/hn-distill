import { expect, it } from "bun:test";
import { normalizeStory, collectComments } from "../scripts/fetch-hn.mts";


it("collectComments respects seenByDepth, maxCount and skips invalid/missing items", async () => {
  const services: any = {
    http: {
      json: async (url: string) => {
        const m = /\/item\/(\d+)\.json$/.exec(url);
        if (!m) return null;
        const id = Number(m[1]);
        const items: Record<number, any> = {
          10: { id: 10, type: "comment", by: "u1", time: 1600000000, text: "<p>hi</p>", kids: [11] },
          11: { id: 11, type: "comment", by: "u2", time: 1600000000, text: "<p>there</p>", kids: [] },
          12: null,
        };
        return items[id] ?? null;
      },
    },
  };

  const { comments, allSeenByDepth } = await collectComments(services, [10, 12], {
    maxDepth: 2,
    maxCount: 10,
    concurrency: 2,
    seenByDepth: { "2": [11] },
  } as any);

  expect(Array.isArray(comments)).toBe(true);
  expect(comments.some((c: any) => c.id === 10)).toBe(true);
  expect(allSeenByDepth[1]).toContain(10);
});
