import { mkdir, stat, readFile, writeFile } from "fs/promises";
import { dirname } from "path";

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

export async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function writeTextFile(path: string, data: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, data, "utf8");
}
