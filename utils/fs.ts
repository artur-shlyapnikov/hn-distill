import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readTextSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeTextFile(path: string, data: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, data, "utf8");
}
