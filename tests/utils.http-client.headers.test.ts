import { describe, test, expect, afterAll } from "bun:test";
import { HttpClient } from "../utils/http-client.ts";

const originalFetch: typeof globalThis.fetch | undefined = (globalThis as any)
  .fetch;

afterAll(() => {
  (globalThis as any).fetch = originalFetch;
});

describe("utils/http-client headers", () => {
  test("json sets Accept header and merges user-agent from opts", async () => {
    let receivedHeaders: Record<string, string> = {};
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      const h = (init?.headers || {}) as Record<string, string>;
      // Normalize header names to lowercase for assertions
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(h))
        lower[k.toLowerCase()] = String(v);
      receivedHeaders = lower;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new HttpClient(
      { retries: 0, baseBackoffMs: 1, timeoutMs: 100, retryOnStatuses: [] },
      { headers: { "x-custom": "1" }, ua: "my-agent/0.1" },
    );
    const res = await client.json<{ ok: boolean }>("http://x");
    expect(res.ok).toBeTrue();
    expect(receivedHeaders["accept"]).toBe("application/json");
    expect(receivedHeaders["user-agent"]).toBe("my-agent/0.1");
    expect(receivedHeaders["x-custom"]).toBe("1");
  });
});
