import { afterAll, describe, expect, test } from "bun:test";
import { HttpClient, HttpError } from "../utils/http-client.ts";

const originalFetch: typeof globalThis.fetch | undefined = (globalThis as Record<string, unknown>)[
  "fetch"
] as typeof globalThis.fetch;

afterAll(() => {
  (globalThis as Record<string, unknown>)["fetch"] = originalFetch;
});

describe("utils/http-client", () => {
  test("json retries on retriable status and eventually succeeds", async () => {
    let calls = 0;
    (globalThis as Record<string, unknown>)["fetch"] = async (): Promise<Response> => {
      calls++;
      if (calls < 2) {
        return new Response("err", { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new HttpClient(
      { retries: 2, baseBackoffMs: 1, timeoutMs: 200, retryOnStatuses: [503] },
      { headers: {} }
    );
    const res = await client.json<{ ok: boolean }>("http://x");
    expect(res.ok).toBeTrue();
    expect(calls).toBe(2);
  });

  test("json times out and wraps errors as HttpError", async () => {
    (globalThis as Record<string, unknown>)["fetch"] = async (): Promise<Response> =>
      new Promise(() => {
        // Empty promise for test
      });
    const client = new HttpClient(
      { retries: 0, baseBackoffMs: 1, timeoutMs: 10, retryOnStatuses: [] },
      { headers: {} }
    );
    const promise = client.json("http://x");
    try {
      await promise;
      throw new Error("Expected promise to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
    }
  }, 200);

  test("json non-OK final response throws HttpError with status", async () => {
    (globalThis as Record<string, unknown>)["fetch"] = async (): Promise<Response> =>
      new Response("bad", { status: 400 });
    const client = new HttpClient(
      { retries: 0, baseBackoffMs: 1, timeoutMs: 50, retryOnStatuses: [] },
      { headers: {} }
    );
    const promise = client.json("http://x");
    try {
      await promise;
      throw new Error("Expected promise to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
    }
    try {
      await client.json("http://x");
    } catch (e) {
      const error = e as HttpError;
      expect(error.status).toBe(400);
    }
  });
});
