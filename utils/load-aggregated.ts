import { existsSync, readFileSync } from "node:fs";
import type { AggregatedItem } from "@config/schemas";

export type AggregatedData = {
  items: AggregatedItem[];
  updatedISO: string;
};

/**
 * Load aggregated data file with safe fallbacks.
 * - Missing file → empty items, updatedISO "—"
 * - Malformed JSON → empty items, updatedISO "—"
 * - Wrong field types → coerce to safe defaults
 */
export function loadAggregated(pathname: string): AggregatedData {
  if (!pathname || !existsSync(pathname)) {
    return { items: [], updatedISO: "—" };
  }
  try {
    const raw = readFileSync(pathname, "utf8");
    const parsed: any = JSON.parse(raw);
    const items = (Array.isArray(parsed?.items) ? parsed.items : []) as AggregatedItem[];
    const updatedISO = typeof parsed?.updatedISO === "string" ? parsed.updatedISO : "—";
    return { items, updatedISO };
  } catch {
    return { items: [], updatedISO: "—" };
  }
}
