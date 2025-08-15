import { describe, expect, test } from "bun:test";

import { HnItemRawSchema } from "@config/schemas";
import type { Services } from "../scripts/fetch-hn.mts";
import { fetchItem, readTopIds } from "../scripts/fetch-hn.mts";
import { makeMockHttp } from "./helpers";

describe("scripts/fetch-hn core", () => {
  test("readTopIds truncates and preserves order", async () => {
    const services = makeMockHttp({ "/\\/topstories\\.json$/": [5, 4, 3, 2, 1] }) as unknown as Services;
    const ids = await readTopIds(services, 3);
    expect(ids).toEqual([5, 4, 3]);
  });

  test("readTopIds returns empty list for empty/invalid API response", async () => {
    const services1 = makeMockHttp({ "/\\/topstories\\.json$/": [] }) as unknown as Services;
    expect(await readTopIds(services1, 5)).toEqual([]);

    const services2 = makeMockHttp({ "/\\/topstories\\.json$/": {} }) as unknown as Services;
    expect(await readTopIds(services2, 5)).toEqual([]);

    const services3 = makeMockHttp({ "/\\/topstories\\.json$/": undefined }) as unknown as Services;
    expect(await readTopIds(services3, 5)).toEqual([]);
  });

  test("fetchItem successfully parses story and comment shapes", async () => {
    const now = 1_700_000_000;
    const storyData = { id: 1, type: "story", title: "A story", by: "user", time: now, kids: [2] };
    const commentData = { id: 2, type: "comment", text: "A comment", by: "user", time: now, parent: 1 };

    const servicesStory = makeMockHttp({ "/\\/item\\/1\\.json$/": storyData }) as unknown as Services;
    const story = await fetchItem(servicesStory, 1);
    expect(story).not.toBeUndefined();
    expect(story?.type).toBe("story");
    expect(HnItemRawSchema.safeParse(story).success).toBeTrue();

    const servicesComment = makeMockHttp({ "/\\/item\\/2\\.json$/": commentData }) as unknown as Services;
    const comment = await fetchItem(servicesComment, 2);
    expect(comment).not.toBeUndefined();
    expect(comment?.type).toBe("comment");
    expect(HnItemRawSchema.safeParse(comment).success).toBeTrue();
  });

  test("fetchItem returns undefined for invalid schema", async () => {
    const invalidData = { id: 1, title: "Missing type" };
    const services = makeMockHttp({ "/\\/item\\/1\\.json$/": invalidData }) as unknown as Services;
    const item = await fetchItem(services, 1);
    expect(item).toBeUndefined();
  });
});