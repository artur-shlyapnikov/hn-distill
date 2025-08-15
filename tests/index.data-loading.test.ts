import { loadAggregated } from "@utils/load-aggregated";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTempDir } from "./helpers";

const AGGREGATED_JSON = "aggregated.json";

describe("index data loading resilience", () => {
  test("returns fallback when file missing", () => {
    const missing = join(tmpdir(), "non-existent", AGGREGATED_JSON);
    const res = loadAggregated(missing);
    expect(res.items).toEqual([]);
    expect(res.updatedISO).toBe("—");
  });

  test("parses valid aggregated.json", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, AGGREGATED_JSON);
      const valid = {
        updatedISO: "2024-01-02T03:04:05.000Z",
        items: [
          {
            id: 1,
            title: "T",
            url: "https://example.com/",
            by: "u",
            timeISO: "2024-01-01T00:00:00.000Z",
            postSummary: "s",
            commentsSummary: "c",
            score: 10,
            commentsCount: 2,
            hnUrl: "https://news.ycombinator.com/item?id=1",
            domain: "example.com",
          },
        ],
      };
      writeFileSync(p, JSON.stringify(valid), "utf8");
      const res = loadAggregated(p);
      expect(Array.isArray(res.items)).toBe(true);
      expect(res.items.length).toBe(1);
      expect(res.updatedISO).toBe(valid.updatedISO);
    });
  });

  test("falls back on malformed JSON", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, AGGREGATED_JSON);
      writeFileSync(p, "{ not valid json", "utf8");
      const res = loadAggregated(p);
      expect(res.items).toEqual([]);
      expect(res.updatedISO).toBe("—");
    });
  });

  test("coerces wrong field types to safe defaults", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, AGGREGATED_JSON);
      const wrong: Record<string, unknown> = { updatedISO: 123, items: "nope" };
      writeFileSync(p, JSON.stringify(wrong), "utf8");
      const res = loadAggregated(p);
      expect(res.items).toEqual([]);
      expect(res.updatedISO).toBe("—");
    });
  });
});
