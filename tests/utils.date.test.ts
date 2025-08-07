import { describe, test, expect } from "bun:test";
import { formatDateHuman } from "../utils/date.ts";

describe("utils/date.formatDateHuman", () => {
  test("returns em-dash for falsy or placeholder", () => {
    expect(formatDateHuman("")).toBe("—");
    expect(formatDateHuman("—")).toBe("—");
  });

  test("returns input if invalid date", () => {
    expect(formatDateHuman("not-a-date")).toBe("not-a-date");
  });

  test("formats a valid ISO string", () => {
    const iso = "2024-01-02T03:04:00.000Z";
    const out = formatDateHuman(iso);
    // We cannot assert exact locale text, but ensure it's non-empty and not the raw ISO
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(5);
    expect(out).not.toBe(iso);
  });
});
