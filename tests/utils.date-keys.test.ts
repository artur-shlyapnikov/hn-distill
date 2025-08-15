import { describe, expect, test } from "bun:test";
import { isoWeekKey, toDateKeyUTC, addDaysUTC } from "@utils/date-keys";

describe("utils/date-keys", () => {
  test("26. isoWeekKey correctness on ISO week boundaries", () => {
    // Thursday Dec 31 2020 is in the last week of 2020 (w53)
    expect(isoWeekKey("2020-12-31T12:00:00Z")).toBe("2020-w53");
    // Friday Jan 1 2021 is also in that same week (w53 of 2020)
    expect(isoWeekKey("2021-01-01T12:00:00Z")).toBe("2020-w53");
    // Monday Jan 4 2021 is the start of the first week of 2021
    expect(isoWeekKey("2021-01-04T12:00:00Z")).toBe("2021-w01");
  });

  test("27. toDateKeyUTC & addDaysUTC across DST/leap transitions", () => {
    expect(toDateKeyUTC("2024-02-29T23:00:00Z")).toBe("2024-02-29");
    expect(addDaysUTC("2024-02-29", 1)).toBe("2024-03-01");
    // Test non-leap year
    expect(addDaysUTC("2023-02-28", 1)).toBe("2023-03-01");
    // Test across a typical DST change boundary in the US (e.g., March)
    expect(addDaysUTC("2024-03-10", 1)).toBe("2024-03-11");
  });
});