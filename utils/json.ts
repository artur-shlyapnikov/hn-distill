import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ensureDir } from "./fs.js";

import type { z } from "zod";

export async function readJsonFile<T>(path: string): Promise<T> {
  const buf = await readFile(path, "utf8");
  return JSON.parse(buf) as T;
}

export async function readJsonSafe<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readJsonFile<unknown>(path);
  try {
    return schema.parse(raw);
  } catch (error) {
    const error_ = error as Error;
    throw new Error(`Invalid JSON at ${path}: ${error_.message}`);
  }
}

export async function readJsonSafeOr<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined>;
export async function readJsonSafeOr<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T>;
export async function readJsonSafeOr<T>(path: string, schema: z.ZodType<T>, fallback?: T): Promise<T | undefined> {
  try {
    return await readJsonSafe<T>(path, schema);
  } catch {
    return fallback;
  }
}

function stableStringify(data: unknown, pretty?: boolean): string {
  return JSON.stringify(data, undefined, pretty ?? true ? 2 : 0);
}

export async function writeJsonFile(
  path: string,
  data: unknown,
  options?: { atomic?: boolean; pretty?: boolean }
): Promise<void> {
  const atomic = options?.atomic ?? true;
  const pretty = options?.pretty ?? true;
  await ensureDir(dirname(path));
  const next = stableStringify(data, pretty);
  const exists = existsSync(path);
  if (exists) {
    try {
      const current = await readFile(path, "utf8");
      if (current === next) {
        return;
      }
    } catch {
      // ignore diff read errors
    }
  }
  if (!atomic) {
    await writeFile(path, next, "utf8");
    return;
  }
  const temporary = `${path}.${Date.now()}.${process.pid}.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, path);
}
