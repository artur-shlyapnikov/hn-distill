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
    const parsed: unknown = JSON.parse(raw);
    function getItems(u: unknown): AggregatedItem[] {
      if (typeof u === "object" && u !== null && "items" in u) {
        const object = u as Record<string, unknown>;
        const maybeItems = object["items"];
        if (Array.isArray(maybeItems)) {
          return maybeItems as AggregatedItem[];
        }
      }
      return [];
    }

    function getUpdatedISO(u: unknown): string {
      if (typeof u === "object" && u !== null && "updatedISO" in u) {
        const object = u as Record<string, unknown>;
        return typeof object["updatedISO"] === "string" ? object["updatedISO"] : "—";
      }
      return "—";
    }

    const items = getItems(parsed);
    const updatedISO = getUpdatedISO(parsed);
    return { items, updatedISO };
  } catch {
    return { items: [], updatedISO: "—" };
  }
}
