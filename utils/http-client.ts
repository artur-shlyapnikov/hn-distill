export type RetryPolicy = {
  retries: number;
  baseBackoffMs: number;
  timeoutMs: number;
  retryOnStatuses: number[];
};

export type HttpClientOpts = {
  headers: Record<string, string>;
  ua?: string;
};

export class HttpError extends Error {
  constructor(public url: string, public status?: number, message?: string) {
    super(message ?? `HTTP error ${status ?? "unknown"} for ${url}`);
    this.name = "HttpError";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const t = setTimeout(() => {
      reject(new Error("TimeoutError"));
    }, ms);

    const cleanup = (): void => {
      clearTimeout(t);
    };

    void (async (): Promise<void> => {
      try {
        const result = await promise;
        cleanup();
        resolve(result);
      } catch (error) {
        cleanup();
        reject(error);
      }
    })();
  });
}

export class HttpClient {
  private readonly baseHeaders: Record<string, string>;

  constructor(private readonly defaults: RetryPolicy, options?: HttpClientOpts) {
    const ua =
      options?.ua ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.7258.123 Safari/537.36";
    this.baseHeaders = { "user-agent": ua, ...(options?.headers ?? {}) };
  }

  private shouldRetryError(error: Error): boolean {
    return error.name === "AbortError" || error.name === "TypeError" || error.message === "TimeoutError";
  }

  private shouldRetryStatus(status: number, retryStatuses: Set<number>): boolean {
    return isDefaultRetriableStatus(status) || retryStatuses.has(status);
  }

  private async handleResponseError(url: string, res: Response): Promise<void> {
    const body = await res.text().catch(() => "");
    throw new HttpError(url, res.status, `HTTP ${res.status} ${body.slice(0, 500)}`);
  }

  private async processAttempt<T>(
    url: string,
    init: SafeRequestInit | undefined,
    processor: (res: Response) => Promise<T>,
    retryStatuses: Set<number>,
    attempt: number,
    maxRetries: number,
    timeoutMs: number,
    baseBackoffMs: number
  ): Promise<T | "retry"> {
    try {
      const res = await this.doFetch(url, init, timeoutMs);

      if (!res.ok) {
        const retriable = this.shouldRetryStatus(res.status, retryStatuses);
        if (retriable && attempt < maxRetries) {
          await sleep(backoffMs(baseBackoffMs, attempt));
          return "retry";
        }
        await this.handleResponseError(url, res);
      }
      return await processor(res);
    } catch (error) {
      const error_ = error as Error;
      if (attempt < maxRetries && this.shouldRetryError(error_)) {
        await sleep(backoffMs(baseBackoffMs, attempt));
        return "retry";
      }
      if (error_ instanceof HttpError) {
        throw error_;
      }
      throw new HttpError(url, undefined, error_.message || "Request failed");
    }
  }

  private async doFetch(url: string, init: SafeRequestInit | undefined, timeoutMs: number): Promise<Response> {
    const headers: HeadersInit = {
      ...(init?.headers ?? {}),
      ...this.baseHeaders,
    };
    const requestInit: RequestInit = {
      ...init,
      headers,
    };
    const request = fetch(url, requestInit);
    return await withTimeout(request, timeoutMs);
  }

  async json<T>(url: string, init?: SafeRequestInit): Promise<T> {
    const retryStatuses = new Set([...(init?.retryOnStatuses ?? []), ...this.defaults.retryOnStatuses]);
    const { retries, timeoutMs, baseBackoffMs } = this.defaults;

    const requestInit = {
      ...init,
      headers: {
        accept: "application/json",
        ...this.baseHeaders,
        ...(init?.headers ?? {}),
      },
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await this.processAttempt(
        url,
        requestInit,
        async (res) => (await res.json()) as T,
        retryStatuses,
        attempt,
        retries,
        timeoutMs,
        baseBackoffMs
      );

      if (result === "retry") {
        continue;
      }
      return result;
    }
    throw new HttpError(url, undefined, "Exhausted retries");
  }

  async text(url: string, init?: SafeRequestInit): Promise<string> {
    const retryStatuses = new Set([...(init?.retryOnStatuses ?? []), ...this.defaults.retryOnStatuses]);
    const { retries, timeoutMs, baseBackoffMs } = this.defaults;

    const requestInit = {
      ...init,
      headers: {
        ...this.baseHeaders,
        ...(init?.headers ?? {}),
      },
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await this.processAttempt(
        url,
        requestInit,
        async (res) => await res.text(),
        retryStatuses,
        attempt,
        retries,
        timeoutMs,
        baseBackoffMs
      );

      if (result === "retry") {
        continue;
      }
      return result;
    }
    throw new HttpError(url, undefined, "Exhausted retries");
  }
}
