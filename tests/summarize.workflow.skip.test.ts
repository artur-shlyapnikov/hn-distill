import { describe, test, expect } from "bun:test";
import { summarizeWorkflow, makeServices } from "../scripts/summarize.mts";
import { env as realEnv } from "../config/env.ts";

function cloneEnv(over: Partial<typeof realEnv> = {}) {
  return { ...realEnv, ...over };
}

describe("summarize.workflow", () => {
  test("skips without OPENROUTER_API_KEY", async () => {
    const fakeEnv = cloneEnv({ OPENROUTER_API_KEY: undefined });
    const services = makeServices(fakeEnv as any);
    // Should return without throwing, regardless of filesystem state
    await expect(summarizeWorkflow(services)).resolves.toBeUndefined();
  });
});
