import { describe, test, expect } from "bun:test";
import { collectComments } from "../scripts/fetch-hn.mts";
import type { HttpClient } from "../utils/http-client.ts";

type Services = { http: HttpClient };

function makeMockHttp(items: Record<number, any>) {
  let calls = 0;
  return {
    http: {
      json: async (url: string) => {
        calls++;
        const m = /item\/(\d+)\.json$/.exec(url);
        if (!m) return null;
        const id = Number(m[1]);
        return items[id] ?? null;
      },
    } as unknown as HttpClient,
    get calls() {
      return calls;
    },
  } as unknown as Services & { calls: number };
}

describe("scripts/fetch-hn collectComments", () => {
  test("honors maxDepth, maxCount, dedup, and skipping empty comments", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data: Record<number, any> = {
      1: { id: 1, type: "comment", by: "u1", text: "<p>One</p>", time: now, parent: 0, kids: [2, 3] },
      2: { id: 2, type: "comment", by: "u2", text: "", time: now, parent: 1, kids: [4] },
      3: { id: 3, type: "comment", by: "u3", text: "<p>Three</p>", time: now, parent: 1, kids: [] },
      4: { id: 4, type: "comment", by: "u4", text: "<p>Four</p>", time: now, parent: 2, kids: [] }
    };
    const services = makeMockHttp(data) as unknown as Services;

    const { comments, allSeenByDepth } = await collectComments(services as any, [1], {
      maxDepth: 2,
      maxCount: 10,
      concurrency: 2,
      seenByDepth: {}
    });

    const ids = comments.map(c => c.id);
    expect(ids).toEqual([1, 3]);
    expect(allSeenByDepth[1]).toContain(1);
    expect(allSeenByDepth[2]).toContain(2);
    expect(allSeenByDepth[2]).toContain(3);
    expect(allSeenByDepth[3]).toBeUndefined();
  });

  test("stops at maxCount", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data: Record<number, any> = {};
    for (let i = 1; i <= 10; i++) {
      data[i] = { id: i, type: "comment", by: "u", text: "x", time: now, parent: i - 1, kids: i < 10 ? [i + 1] : [] };
    }
    const services = makeMockHttp(data) as any;

    const { comments } = await collectComments(services, [1], {
      maxDepth: 10,
      maxCount: 3,
      concurrency: 2,
      seenByDepth: {}
    });

    expect(comments.length).toBe(3);
    expect(comments.map(c => c.id)).toEqual([1, 2, 3]);
  });
});
