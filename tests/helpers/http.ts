import type { HttpClient } from "@utils/http-client";

/**
 * Simple HTTP mock. Pass routes as a map where keys are strings like "/pattern/flags".
 * Examples:
 *   makeMockHttp({ "/\\/topstories\\.json$/": [1,2,3] })
 *   makeMockHttp({ "/^https:\\/\\/example\\.com\\/?$/u": "<h1>Hello</h1>" })
 */
export function makeMockHttp(routes: Record<string, unknown>) {
  let calls = 0;

  function toRegExp(key: string): RegExp {
    // Accept "/pattern/" or "/pattern/flags"
    const m = /^\/(.*)\/([a-z]*)$/i.exec(key);
    if (m) {
      const [, source, flags] = m;
      try {
        return new RegExp(source ?? "", flags ?? "");
      } catch {
        return new RegExp(source ?? "");
      }
    }
    // Fallback: treat the whole key as the source
    return new RegExp(key);
  }

  const http = {
    json: async <T>(url: string): Promise<T | null> => {
      calls++;
      for (const [key, val] of Object.entries(routes)) {
        const r = toRegExp(key);
        if (r.test(url)) {
          return (val as T) ?? null;
        }
      }
      return null as unknown as T;
    },
    text: async (url: string): Promise<string> => {
      calls++;
      for (const [key, val] of Object.entries(routes)) {
        const r = toRegExp(key);
        if (r.test(url)) {
          return String(val);
        }
      }
      return "";
    },
  } as unknown as HttpClient;

  return {
    http,
    get calls() {
      return calls;
    },
  };
}
