import { describe, expect, test } from "bun:test";
import { env as realEnvironment } from "../config/env.ts";
import { makeServices, summarizeWorkflow } from "../scripts/summarize.mts";

function cloneEnvironment(over: Partial<typeof realEnvironment> = {}): typeof realEnvironment {
  return { ...realEnvironment, ...over };
}

describe("summarize.workflow", () => {
  test("skips without OPENROUTER_API_KEY", async () => {
    const fakeEnvironment = cloneEnvironment({ OPENROUTER_API_KEY: undefined });
    const services = makeServices(fakeEnvironment);
    // Should return without throwing, regardless of filesystem state
    expect(summarizeWorkflow(services, fakeEnvironment)).resolves.toBeUndefined();
  });
});
