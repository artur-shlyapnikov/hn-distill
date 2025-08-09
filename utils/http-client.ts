export interface RetryPolicy {
  retries: number;
  baseBackoffMs: number;
  timeoutMs: number;
  retryOnStatuses: number[];
}

export interface HttpClientOpts {
  headers: Record<string, string>;
  ua?: string;
}

export class HttpError extends Error {
  constructor(public url: string, public status?: number, message?: string) {
    super(message ?? `HTTP error ${status ?? "unknown"} for ${url}`);
    this.name = "HttpError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(base: number, attempt: number): number {
  const raw = base * Math.pow(2, attempt) + Math.floor(Math.random() * 120);
  return Math.min(raw, 5000);
}

function isDefaultRetriableStatus(s: number): boolean {
  return s === 408 || s === 425 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504 || s === 522;
}

export type BodyInitLike = BodyInit;
type HeadersLike = Record<string, string>;
type SafeRequestInit = Omit<RequestInit, "body" | "headers" | "signal"> & {
  body?: BodyInitLike;
  headers?: HeadersLike;
  retryOnStatuses?: number[];
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("TimeoutError")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export class HttpClient {
  private baseHeaders: Record<string, string>;

  constructor(private defaults: RetryPolicy, opts?: HttpClientOpts) {
    const ua = opts?.ua ?? "hn-distill/1.0 (+https://github.com/hn-distill)";
    this.baseHeaders = { "user-agent": ua, ...(opts?.headers ?? {}) };
  }

  private async doFetch(url: string, init: SafeRequestInit | undefined, timeoutMs: number): Promise<Response> {
    const req = fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...this.baseHeaders,
      } as HeadersInit,
    } as RequestInit);
    return await withTimeout(req, timeoutMs);
  }

  async json<T>(url: string, init?: SafeRequestInit): Promise<T> {
    const retryStatuses = new Set([...(init?.retryOnStatuses ?? []), ...this.defaults.retryOnStatuses]);
    const retries = this.defaults.retries;
    const timeoutMs = this.defaults.timeoutMs;
    const baseBackoff = this.defaults.baseBackoffMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.doFetch(
          url,
          {
            ...init,
            headers: {
              accept: "application/json",
              ...this.baseHeaders,
              ...(init?.headers ?? {}),
            },
          },
          timeoutMs
        );

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const retriable = isDefaultRetriableStatus(res.status) || retryStatuses.has(res.status);
          if (retriable && attempt < retries) {
            await sleep(backoffMs(baseBackoff, attempt));
            continue;
          }
          throw new HttpError(url, res.status, `HTTP ${res.status} ${body.slice(0, 500)}`);
        }
        return (await res.json()) as T;
      } catch (e) {
        const err = e as Error;
        const retriable = err.name === "AbortError" || err.name === "TypeError" || err.message === "TimeoutError";
        if (attempt < retries && retriable) {
          await sleep(backoffMs(baseBackoff, attempt));
          continue;
        }
        if (err instanceof HttpError) throw err;
        throw new HttpError(url, undefined, err.message || "Request failed");
      }
    }
    throw new HttpError(url, undefined, "Exhausted retries");
  }

  async text(url: string, init?: SafeRequestInit): Promise<string> {
    const retryStatuses = new Set([...(init?.retryOnStatuses ?? []), ...this.defaults.retryOnStatuses]);
    const retries = this.defaults.retries;
    const timeoutMs = this.defaults.timeoutMs;
    const baseBackoff = this.defaults.baseBackoffMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.doFetch(
          url,
          {
            ...init,
            headers: {
              ...this.baseHeaders,
              ...(init?.headers ?? {}),
            },
          },
          timeoutMs
        );

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const retriable = isDefaultRetriableStatus(res.status) || retryStatuses.has(res.status);
          if (retriable && attempt < retries) {
            await sleep(backoffMs(baseBackoff, attempt));
            continue;
          }
          throw new HttpError(url, res.status, `HTTP ${res.status} ${body.slice(0, 500)}`);
        }
        return await res.text();
      } catch (e) {
        const err = e as Error;
        const retriable = err.name === "AbortError" || err.name === "TypeError" || err.message === "TimeoutError";
        if (attempt < retries && retriable) {
          await sleep(backoffMs(baseBackoff, attempt));
          continue;
        }
        if (err instanceof HttpError) throw err;
        throw new HttpError(url, undefined, err.message || "Request failed");
      }
    }
    throw new HttpError(url, undefined, "Exhausted retries");
  }
}
