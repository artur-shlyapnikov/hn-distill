import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { writeJsonFile, readJsonSafeOr } from "../utils/json.ts";
import { z } from "zod";
import { withTempDir } from "./helpers";
import { readFile } from "node:fs/promises";

describe("utils/json", () => {
  test("writeJsonFile writes atomically and skips identical content", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "file.json");
      await writeJsonFile(p, { a: 1 }, { atomic: true, pretty: true });
      const first = await readFile(p, "utf8");
      await writeJsonFile(p, { a: 1 }, { atomic: true, pretty: true });
      const second = await readFile(p, "utf8");
      expect(first).toBe(second);
    });
  });

  test("readJsonSafeOr returns fallback on missing/invalid and validates when valid", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "bad.json");
      const schema = z.object({ ok: z.boolean() });

      // Missing file -> fallback
      const res1 = await readJsonSafeOr(p, schema, { ok: false });
      expect(res1.ok).toBeFalse();

      // Valid file -> parsed
      await writeJsonFile(p, { ok: true }, { atomic: true, pretty: false });
      const res2 = await readJsonSafeOr(p, schema, { ok: false });
      expect(res2.ok).toBeTrue();
    });
  });
});
