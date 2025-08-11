import type { AggregatedItem } from "@config/schemas";
import { existsSync, readFileSync } from "node:fs";

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
    const parsed: unknown = JSON.parse(raw);
    function getItems(u: unknown): AggregatedItem[] {
      if (typeof u === "object" && u !== null) {
        // narrow with runtime checks
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const maybeItems = (u as any).items;
        if (Array.isArray(maybeItems)) return maybeItems as AggregatedItem[];
      }
      return [];
    }
    const items = getItems(parsed);
    const updatedISO = typeof (parsed as any)?.updatedISO === "string" ? (parsed as any).updatedISO : "—";
    return { items, updatedISO };
  } catch {
    return { items: [], updatedISO: "—" };
  }
}
