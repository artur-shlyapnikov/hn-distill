import type { NormalizedStory, NormalizedComment, AggregatedItem } from "@config/schemas";

export const TEST_ISO = "2024-01-02T03:04:05.000Z";

export function story(over: Partial<NormalizedStory> = {}): NormalizedStory {
  return {
    id: 1,
    title: "Title",
    url: "https://example.com/",
    by: "u",
    timeISO: TEST_ISO,
    commentIds: [],
    ...over,
  };
}

export function comment(over: Partial<NormalizedComment> = {}): NormalizedComment {
  return {
    id: 11,
    by: "c",
    timeISO: TEST_ISO,
    textPlain: "Comment",
    parent: 1,
    depth: 1,
    ...over,
  };
}

export function aggItem(over: Partial<AggregatedItem> = {}): AggregatedItem {
  return {
    id: 1,
    title: "T",
    url: null,
    by: "u",
    timeISO: TEST_ISO,
    ...over,
  };
}