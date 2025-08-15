import { describe, expect, test } from "bun:test";

import { HnItemRawSchema } from "@config/schemas";
import type { Services } from "../scripts/fetch-hn.mts";
import { fetchItem, readTopIds } from "../scripts/fetch-hn.mts";
import type { HttpClient } from "../utils/http-client.ts";

// Mock HttpClient for testing
function makeMockHttp(responses: Record<string, unknown>): Services {
  return {
    http: {
      json: async <T>(url: string): Promise<T> => {
        for (const key in responses) {
          if (url.endsWith(key)) {
            if (responses[key] === undefined) {
              throw new Error(`Simulated fetch error for ${url}`);
            }
            return responses[key] as T;
          }
        }
        throw new Error(`No mock for URL: ${url}`);
      },
    } as unknown as HttpClient,
  };
}

describe("scripts/fetch-hn core", () => {
  // 1. readTopIds truncates and preserves order
  test("readTopIds truncates and preserves order", async () => {
    const services = makeMockHttp({ "/topstories.json": [5, 4, 3, 2, 1] });
    const ids = await readTopIds(services, 3);
    expect(ids).toEqual([5, 4, 3]);
  });

  // 7. readTopIds empty/invalid API → empty list (negative)
  test("readTopIds returns empty list for empty/invalid API response", async () => {
    const services1 = makeMockHttp({ "/topstories.json": [] });
    expect(await readTopIds(services1, 5)).toEqual([]);

    const services2 = makeMockHttp({ "/topstories.json": {} });
    expect(await readTopIds(services2, 5)).toEqual([]);

    const services3 = makeMockHttp({ "/topstories.json": undefined });
    expect(await readTopIds(services3, 5)).toEqual([]);
  });

  // 2. fetchItem successfully parses both story and comment shapes
  test("fetchItem successfully parses story and comment shapes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const storyData = { id: 1, type: "story", title: "A story", by: "user", time: now, kids: [2] };
    const commentData = { id: 2, type: "comment", text: "A comment", by: "user", time: now, parent: 1 };

    const servicesStory = makeMockHttp({ "/item/1.json": storyData });
    const story = await fetchItem(servicesStory, 1);
    expect(story).not.toBeUndefined();
    expect(story?.type).toBe("story");
    expect(HnItemRawSchema.safeParse(story).success).toBeTrue();

    const servicesComment = makeMockHttp({ "/item/2.json": commentData });
    const comment = await fetchItem(servicesComment, 2);
    expect(comment).not.toBeUndefined();
    expect(comment?.type).toBe("comment");
    expect(HnItemRawSchema.safeParse(comment).success).toBeTrue();
  });

  // 8. fetchItem invalid schema → undefined (negative)
  test("fetchItem returns undefined for invalid schema", async () => {
    const invalidData = { id: 1, title: "Missing type" };
    const services = makeMockHttp({ "/item/1.json": invalidData });
    const item = await fetchItem(services, 1);
    expect(item).toBeUndefined();
  });
});