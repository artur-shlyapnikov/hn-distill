import { describe, expect, test } from "bun:test";
import { collectComments } from "../scripts/fetch-hn.mts";
import type { HttpClient } from "../utils/http-client.ts";

type Services = { http: HttpClient };

function makeMockHttp(items: Record<number, unknown>): Services & { calls: number } {
  let calls = 0;
  return {
    http: {
      json: async <T>(url: string): Promise<T | null> => {
        calls++;
        const m = /item\/(?<id>\d+)\.json$/u.exec(url);
        if (!m) {
          return null;
        }
        const id = Number(m.groups?.["id"]);
        return (items[id] as T) ?? null;
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
    const data: Record<number, unknown> = {
      1: { id: 1, type: "comment", by: "u1", text: "<p>One</p>", time: now, parent: 0, kids: [2, 3] },
      2: { id: 2, type: "comment", by: "u2", text: "", time: now, parent: 1, kids: [4] },
      3: { id: 3, type: "comment", by: "u3", text: "<p>Three</p>", time: now, parent: 1, kids: [] },
      4: { id: 4, type: "comment", by: "u4", text: "<p>Four</p>", time: now, parent: 2, kids: [] },
    };
    const services = makeMockHttp(data) as unknown as Services;

    const { comments, allSeenByDepth } = await collectComments(services, [1], {
      maxDepth: 2,
      maxCount: 10,
      concurrency: 2,
      seenByDepth: {},
    });

    const ids = comments.map((c) => c.id);
    expect(ids).toEqual([1, 3]);
    expect(allSeenByDepth[1]).toContain(1);
    expect(allSeenByDepth[2]).toContain(2);
    expect(allSeenByDepth[2]).toContain(3);
    expect(allSeenByDepth[3]).toBeUndefined();
  });

  test("stops at maxCount", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data: Record<number, unknown> = {};
    for (let index = 1; index <= 10; index++) {
      data[index] = {
        id: index,
        type: "comment",
        by: "u",
        text: "x",
        time: now,
        parent: index - 1,
        kids: index < 10 ? [index + 1] : [],
      };
    }
    const services = makeMockHttp(data);

    const { comments } = await collectComments(services, [1], {
      maxDepth: 10,
      maxCount: 3,
      concurrency: 2,
      seenByDepth: {},
    });

    expect(comments.length).toBe(3);
    expect(comments.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  test("clamps text and strips HTML", async () => {
    const longText = `<p>A</p>${  "x".repeat(9999)}`;
    const data = {
      1: { id: 1, type: "comment", text: longText, time: Math.floor(Date.now() / 1000), parent: 0, kids: [] },
    };
    const services = makeMockHttp(data);
    const { env } = await import("../config/env.ts");
    const originalMaxBodyChars = env.MAX_BODY_CHARS;
    env.MAX_BODY_CHARS = 2000;

    const { comments } = await collectComments(services, [1], {
      maxDepth: 1,
      maxCount: 1,
      concurrency: 1,
      seenByDepth: {},
    });

    expect(comments.length).toBe(1);
    const comment = comments[0]!;
    expect(comment.textPlain).not.toContain("<p>");
    expect(comment.textPlain.length).toBe(2000);

    // reset env
    env.MAX_BODY_CHARS = originalMaxBodyChars;
  });

  test("prevents cycles and duplicate enqueues", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data = {
      1: { id: 1, type: "comment", text: "1", time: now, parent: 0, kids: [2, 3] },
      2: { id: 2, type: "comment", text: "2", time: now, parent: 1, kids: [1] }, // cycle to 1
      3: { id: 3, type: "comment", text: "3", time: now, parent: 1, kids: [4] },
      4: { id: 4, type: "comment", text: "4", time: now, parent: 3, kids: [2] }, // duplicate enqueue of 2
    };
    const services = makeMockHttp(data);
    const { comments } = await collectComments(services, [1], {
      maxDepth: 4,
      maxCount: 50,
      concurrency: 2,
      seenByDepth: {},
    });

    const ids = comments.map((c) => c.id);
    const uniqueIds = [...new Set(ids)];
    expect(ids.length).toBe(uniqueIds.length);
    expect(new Set(ids)).toEqual(new Set([1, 2, 3, 4]));
  });

  test("respects seenByDepth across runs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data = {
      100: { id: 100, type: "comment", text: "root", time: now, parent: 0, kids: [3, 4, 5] },
      3: { id: 3, type: "comment", text: "3", time: now, parent: 100, kids: [] },
      4: { id: 4, type: "comment", text: "4", time: now, parent: 100, kids: [] },
      5: { id: 5, type: "comment", text: "5", time: now, parent: 100, kids: [] },
    };
    const services = makeMockHttp(data);
    const { comments, allSeenByDepth } = await collectComments(services, [100], {
      maxDepth: 2,
      maxCount: 10,
      concurrency: 2,
      seenByDepth: { "2": [3, 4] }, // Kids of 100 are at depth 2.
    });

    const ids = comments.map((c) => c.id);
    expect(ids).toContain(100);
    expect(ids).toContain(5);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);

    expect(allSeenByDepth[1]).toEqual([100]);
    expect(allSeenByDepth[2]).toEqual([5]);
  });
});
