import { env } from "@config/env";
import { HttpClient, type RetryPolicy } from "./http-client.js";

const defaultPolicy: RetryPolicy = {
  retries: env.HTTP_RETRIES,
  baseBackoffMs: env.HTTP_BACKOFF_MS,
  timeoutMs: env.HTTP_TIMEOUT_MS,
  retryOnStatuses: [408, 425, 429, 500, 502, 503, 504, 522],
};

export const httpClient = new HttpClient(defaultPolicy, {
  ua: "hn-distill/1.0 (+https://github.com/hn-distill)",
  headers: {},
});
