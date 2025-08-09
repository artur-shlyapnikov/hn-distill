import { readFile, writeFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import { ensureDir } from "./fs.js";

export async function readJsonFile<T>(path: string): Promise<T> {
  const buf = await readFile(path, "utf8");
  return JSON.parse(buf) as T;
}

export async function readJsonSafe<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await readJsonFile<unknown>(path);
  try {
    return schema.parse(raw);
  } catch (e) {
    const err = e as Error;
    throw new Error(`Invalid JSON at ${path}: ${err.message}`);
  }
}

export async function readJsonSafeOr<T>(
  path: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  try {
    return await readJsonSafe<T>(path, schema);
  } catch {
    return fallback;
  }
}

function stableStringify(data: unknown, pretty = true): string {
  return JSON.stringify(data, null, pretty ? 2 : 0);
}

export async function writeJsonFile(
  path: string,
  data: unknown,
  options?: { atomic?: boolean; pretty?: boolean },
): Promise<void> {
  const atomic = options?.atomic ?? true;
  const pretty = options?.pretty ?? true;
  await ensureDir(dirname(path));
  const next = stableStringify(data, pretty);
  const exists = existsSync(path);
  if (exists) {
    try {
      const curr = await readFile(path, "utf8");
      if (curr === next) return;
    } catch {
      // ignore diff read errors
    }
  }
  if (!atomic) {
    await writeFile(path, next, "utf8");
    return;
  }
  const tmp = `${path}.${Date.now()}.${process.pid}.tmp`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, path);
}
