import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAggregated } from "@utils/load-aggregated";

describe("index data loading resilience", () => {
  test("returns fallback when file missing", () => {
    const missing = join(tmpdir(), "non-existent", "aggregated.json");
    const res = loadAggregated(missing);
    expect(res.items).toEqual([]);
    expect(res.updatedISO).toBe("—");
  });

  test("parses valid aggregated.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-valid-"));
    const p = join(dir, "aggregated.json");
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
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-malformed-"));
    const p = join(dir, "aggregated.json");
    writeFileSync(p, "{ not valid json", "utf8");
    const res = loadAggregated(p);
    expect(res.items).toEqual([]);
    expect(res.updatedISO).toBe("—");
    rmSync(dir, { recursive: true, force: true });
  });

  test("coerces wrong field types to safe defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "agg-wrong-types-"));
    const p = join(dir, "aggregated.json");
    const wrong = { updatedISO: 123, items: "nope" } as any;
    writeFileSync(p, JSON.stringify(wrong), "utf8");
    const res = loadAggregated(p);
    expect(res.items).toEqual([]);
    expect(res.updatedISO).toBe("—");
    rmSync(dir, { recursive: true, force: true });
  });
});

