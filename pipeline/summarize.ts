import { env, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  CommentsSummarySchema,
  IndexSchema,
  NormalizedCommentSchema,
  NormalizedStorySchema,
  PostSummarySchema,
  TagsSummarySchema,
  type CommentsSummary,
  type NormalizedComment,
  type NormalizedStory,
  type PostSummary,
} from "@config/schemas";
import { decodeText, looksLikeHtml, looksLikePdf } from "@utils/content-detect";
import { sha256Hex } from "@utils/hash";
import { htmlToMd } from "@utils/html-to-md";
import { HttpClient, HttpError } from "@utils/http-client";
import { log } from "@utils/log";
import { readJsonSafeOrStore, type ObjectStore } from "@utils/object-store";
import { OpenRouter, type ChatMessage } from "@utils/openrouter";
import { runSummaryGuard, type SummaryGuardResult } from "@utils/summary-guard";
import { checkSummaryHeuristics } from "@utils/summary-heuristics";
import { buildTagsPrompt, combineAndCanon, summarizeTagsStructured } from "@utils/tags-extract";
import { fetchYouTubeTranscript, getVideoId, isYouTubeUrl } from "@utils/youtube";

import { publishTelegramAfterSummary } from "./telegram-stream";

import type { PdfToTextOptions } from "@utils/pdf";
import type { z } from "zod";

export type Services = {
  http: HttpClient;
  openrouter: OpenRouter;
  fetchArticleMarkdown: (url: string) => Promise<string>;
  pdfToText?: (bytes: Uint8Array, opts?: PdfToTextOptions) => Promise<string>;
};

export function makeServices(
  e: Env,
  options?: { pdfToText?: (bytes: Uint8Array, opts?: PdfToTextOptions) => Promise<string> }
): Services {
  const http = new HttpClient(
    {
      retries: e.HTTP_RETRIES,
      baseBackoffMs: e.HTTP_BACKOFF_MS,
      timeoutMs: e.HTTP_TIMEOUT_MS,
      retryOnStatuses: [408, 425, 429, 500, 502, 503, 504, 522],
    },
    {
      ua: "hn-distill/1.1 (+https://hckr.top/)",
      headers: {},
    }
  );
  const openrouter = new OpenRouter(http, e.OPENROUTER_API_KEY ?? "", e.OPENROUTER_MODEL);

  async function fetchArticleMarkdown(url: string): Promise<string> {
    const youtubeText = await tryFetchYouTubeContent(url);
    if (youtubeText) {
      return youtubeText;
    }

    const { data, contentType } = await http.bytes(url);
    return parseFetchedContent(url, data, contentType ?? undefined);
  }

  async function tryFetchYouTubeContent(url: string): Promise<string | undefined> {
    try {
      const parsed = new URL(url);
      if (!isYouTubeUrl(parsed)) {
        return undefined;
      }
      const vid = getVideoId(parsed);
      if (!vid) {
        return undefined;
      }
      log.info(LOG_NAMESPACE_ARTICLE, "Fetching YouTube transcript", { url, vid });
      const prefer =
        (e.YT_TRANSCRIPT_LANGS?.length ?? 0) > 0
          ? e.YT_TRANSCRIPT_LANGS ?? [e.SUMMARY_LANG, "en"]
          : [e.SUMMARY_LANG, "en"];
      const transcript = await fetchYouTubeTranscript(http, vid, prefer);
      const trimmed = transcript?.text.trim();
      if (trimmed) {
        return trimmed;
      }
      log.warn(LOG_NAMESPACE_ARTICLE, "No captions available; falling back to HTML", { url, vid });
    } catch {
      // Not a valid URL or transcript fetch failed; fall back to fetching bytes.
    }
    return undefined;
  }

  async function parseFetchedContent(url: string, data: Uint8Array, contentType?: string): Promise<string> {
    const head = data.subarray(0, 8);
    if (looksLikePdf({ url, contentType, bytesHead: head })) {
      log.info(LOG_NAMESPACE_ARTICLE, "Fetching and parsing PDF", { url, contentType, bytes: data.length });
      if (!options?.pdfToText) {
        log.warn(LOG_NAMESPACE_ARTICLE, "PDF parsing disabled; skipping", { url, contentType });
        return "";
      }
      try {
        const text = await options.pdfToText(data, {
          maxPages: e.PDF_MAX_PAGES,
          softMaxBytes: e.PDF_MAX_BYTES,
        });
        log.debug(LOG_NAMESPACE_ARTICLE, "PDF parsed successfully", { url, textLength: text.length });
        return text;
      } catch (error) {
        log.error(LOG_NAMESPACE_ARTICLE, "PDF parse failed", { url, error: String(error) });
        return "";
      }
    }
    if (looksLikeHtml(contentType)) {
      log.debug(LOG_NAMESPACE_ARTICLE, "Processing HTML content", { url, contentType });
      const html = decodeText(data, contentType);
      return htmlToMd(html);
    }
    log.debug(LOG_NAMESPACE_ARTICLE, "Processing as plain text", { url, contentType });
    try {
      const text = decodeText(data, contentType);
      return text.trim();
    } catch (error) {
      log.warn(LOG_NAMESPACE_ARTICLE, "Text decode failed", { url, contentType, error: String(error) });
      return "";
    }
  }

  log.debug("summarize/services", "initialized", {
    hasOpenRouterKey: !!e.OPENROUTER_API_KEY,
    model: e.OPENROUTER_MODEL,
  });

  return { http, openrouter, fetchArticleMarkdown };
}

const TAGS_DEBUG_MESSAGE = "summarize/tags";

// Log namespaces
const LOG_NAMESPACE_LLM = "summarize/llm" as const;
const LOG_NAMESPACE_POST = "summarize/post" as const;
const LOG_NAMESPACE_COMMENTS = "summarize/comments" as const;
const LOG_NAMESPACE_ARTICLE = "summarize/article" as const;
const LOG_NAMESPACE_GUARD = "summarize/guard" as const;

type LlmLogContext = Record<string, unknown>;

type SummarizePostOptions = {
  strictSystem?: boolean;
  context?: LlmLogContext;
};

type PostSummaryValidated = {
  summary: string;
  modelUsed: string;
  guard?: SummaryGuardResult;
};

const POST_SUMMARY_ATTEMPTS: Array<{ label: string; strict: boolean }> = [
  { label: "initial", strict: false },
  { label: "strict-1", strict: true },
  { label: "strict-2", strict: true },
];

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

function parseHttpErrorJson(error: HttpError): unknown {
  const { message } = error;
  const firstSpace = message.indexOf(" ");
  if (firstSpace === -1) {
    return undefined;
  }
  const secondSpace = message.indexOf(" ", firstSpace + 1);
  if (secondSpace === -1) {
    return undefined;
  }
  const jsonPart = message.slice(secondSpace + 1).trim();
  if (!jsonPart) {
    return undefined;
  }
  try {
    return JSON.parse(jsonPart);
  } catch {
    return undefined;
  }
}

function parseRateLimitScope(message?: string): string | undefined {
  if (!message) {
    return undefined;
  }
  const trimmed = message.trim();
  const prefix = "Rate limit exceeded:";
  if (!trimmed.startsWith(prefix)) {
    return undefined;
  }
  return (
    trimmed
      .slice(prefix.length)
      .replace(/\.\s*$/u, "")
      .trim() || undefined
  );
}

function parseNumberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseResetHeader(value: unknown): number | undefined {
  const parsed = parseNumberish(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed > 1_000_000_000_000) {
    return Math.floor(parsed);
  }
  if (parsed > 0) {
    return Math.floor(parsed * 1000);
  }
  return undefined;
}

type RateLimitDetails = {
  scope?: string | undefined;
  limit?: number | undefined;
  remaining?: number | undefined;
  resetEpochMs?: number | undefined;
};

function extractRateLimitDetails(error: HttpError): RateLimitDetails | undefined {
  const json = parseHttpErrorJson(error);
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const errorPayload = (json as { error?: unknown }).error;
  if (!errorPayload || typeof errorPayload !== "object") {
    return undefined;
  }
  const errorObj = errorPayload as { message?: unknown; metadata?: unknown };
  const { message, metadata } = errorObj;
  const headers = metadata && typeof metadata === "object" ? (metadata as { headers?: unknown }).headers : undefined;

  const headerRecord = headers && typeof headers === "object" ? (headers as Record<string, unknown>) : undefined;

  const limit = headerRecord ? parseNumberish(headerRecord["X-RateLimit-Limit"]) : undefined;
  const remaining = headerRecord ? parseNumberish(headerRecord["X-RateLimit-Remaining"]) : undefined;
  const resetEpochMs = headerRecord ? parseResetHeader(headerRecord["X-RateLimit-Reset"]) : undefined;

  const result: RateLimitDetails = {};
  if (typeof message === "string") {
    result.scope = parseRateLimitScope(message);
  }
  if (limit !== undefined) {
    result.limit = limit;
  }
  if (remaining !== undefined) {
    result.remaining = remaining;
  }
  if (resetEpochMs !== undefined) {
    result.resetEpochMs = resetEpochMs;
  }
  return result;
}

type RateLimitErrorInit = RateLimitDetails & {
  model: string;
};

export class RateLimitError extends Error {
  readonly model: string;
  readonly limitScope?: string | undefined;
  readonly limit?: number | undefined;
  readonly remaining?: number | undefined;
  readonly resetEpochMs?: number | undefined;

  constructor(init: RateLimitErrorInit, options?: { cause?: Error }) {
    const parts = ["OpenRouter rate limit hit"];
    if (init.model) {
      parts.push(`model ${init.model}`);
    }
    if (init.scope) {
      parts.push(`(${init.scope})`);
    }
    super(parts.join(" "), options);
    this.name = "RateLimitError";
    this.model = init.model;
    this.limitScope = init.scope ?? undefined;
    this.limit = init.limit ?? undefined;
    this.remaining = init.remaining ?? undefined;
    this.resetEpochMs = init.resetEpochMs ?? undefined;
  }

  get retryDate(): Date | undefined {
    return typeof this.resetEpochMs === "number" ? new Date(this.resetEpochMs) : undefined;
  }

  toLogMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: this.model,
      limitScope: this.limitScope,
      limit: this.limit,
      remaining: this.remaining,
      retryISO: this.retryDate?.toISOString(),
      resetEpochMs: this.resetEpochMs,
      ...extra,
    };
  }
}

class LlmCallError extends Error {
  readonly attempt: "fallback" | "primary";
  readonly model: string;
  readonly context: LlmLogContext;

  constructor(attempt: "fallback" | "primary", model: string, context: LlmLogContext, options: { cause: Error }) {
    super(`OpenRouter ${attempt} call failed for model ${model}`, options);
    this.name = "LlmCallError";
    this.attempt = attempt;
    this.model = model;
    this.context = context;
  }

  describe(): string {
    const causeMessage = this.cause instanceof Error ? this.cause.message : undefined;
    return causeMessage ? `${this.message}: ${causeMessage}` : this.message;
  }

  toError(): Error {
    return this.cause instanceof Error ? this.cause : this;
  }

  toLogMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: this.model,
      attempt: this.attempt,
      ...this.context,
      error: this.cause instanceof Error ? this.cause.message : this.message,
      ...extra,
    };
  }
}

async function hashString(s: string): Promise<string> {
  return await sha256Hex(s);
}

function buildPostSystemInstruction(strict?: boolean): string {
  const isStrict = strict === true;
  if (env.SUMMARY_LANG === "en") {
    const base = [
      "You craft tight and concise Hacker News article distillations in Markdown. In English.",
      "Aim for roughly 170 words across two short paragraphs; add a third only if it truly helps.",
      "Spotlight the core idea plus one or two vivid facts, quotes, or numbers readers should remember.",
      "Skip titles, bylines, publication dates, and source attributions.",
      "Begin directly—no headings like 'Summary:' and no closing sign-offs.",
      "Important: mention all the key information from the article, don't lose it. Be precise and concise.",
    ];
    if (isStrict) {
      base.push(
        "Never apologise, mention policies, or refuse the task.",
        "If the source lacks detail, state the concrete facts that do exist; do not speculate or say the article is unavailable.",
        "Do not reference yourself or the request."
      );
    }
    return base.join("\n");
  }

  const base = [
    "Ты пишешь точные и ёмкие пересказы статей Hacker News в Markdown на русском языке.",
    "Стремись к ~170 словам в двух коротких абзацах; третий добавляй только если он действительно помогает.",
    "Выделяй главную идею и пару ярких фактов, цитат или цифр, которые стоит запомнить.",
    "Не называй заголовок, автора, дату публикации и источники.",
    "Начинай сразу с сути, без заголовков вроде 'Саммари:' и без финальных клише.",
    "Важно: упоминай всю ключевую информацию из статьи, не теряй её. Будь точен и лаконичен.",
  ];
  if (isStrict) {
    base.push(
      "Никаких отказов, извинений или упоминаний политик.",
      "Если в материале мало деталей, перескажи то, что есть, и укажи ключевые факты.",
      "Не упоминай себя и само задание."
    );
  }
  return base.join("\n");
}

function buildCommentsLanguageHeader(): string {
  if (env.SUMMARY_LANG === "en") {
    return (
      "Language: en\n" +
      // Style guardrails to avoid chatty prefaces
      "Summarize the discussion as 5–7 concise bullet points.\n" +
      "Output must be a markdown bullet list only, starting immediately with '- '.\n" +
      "Do not add any introductions, headings, prefaces, phrases like 'Summary:', 'Key takeaways:', or closing sentences.\n" +
      "No extra text before or after the list."
    );
  }
  return (
    "Language: ru\n" +
    "Суммаризируй обсуждение в 3-5 лаконичных буллетах.\n" +
    "Выводи только маркированный список в Markdown, сразу начинай с '- '.\n" +
    "Без вступлений, заголовков и фраз вида 'Саммари:', 'Основные тезисы обсуждения:', 'Вот саммари обсуждения:', и без заключений.\n" +
    "Никакого дополнительного текста до или после списка."
  );
}

export async function buildPostPrompt(story: NormalizedStory, articleMd?: string): Promise<string> {
  const content = (articleMd ?? "").trim();
  if (!content) {
    log.warn(LOG_NAMESPACE_POST, "No article content – skipping post prompt", { id: story.id });
    return "";
  }
  const articleSlice = content.slice(0, env.ARTICLE_SLICE_CHARS);
  log.debug(LOG_NAMESPACE_POST, "Built post prompt", { id: story.id, promptChars: articleSlice.length });
  return articleSlice;
}

export async function buildCommentsPrompt(
  comments: NormalizedComment[]
): Promise<{ prompt: string; sampleIds: number[] }> {
  const header = buildCommentsLanguageHeader();
  const { OPENROUTER_MAX_TOKENS } = env;
  let budget = 6 * OPENROUTER_MAX_TOKENS;
  const lines: string[] = [];
  for (const c of comments) {
    const { textPlain, by, depth } = c;
    const text = textPlain ? textPlain.replaceAll(/\s+/gu, " ").trim() : "";
    if (!text) {
      continue;
    }
    const line = `@${by} [d${depth}] ${text.slice(0, 400)}`;
    const cost = line.length + 1;
    if (budget - cost < 0) {
      break;
    }
    lines.push(line);
    budget -= cost;
  }
  const sampleIds = comments
    .filter((c) => {
      const { textPlain } = c;
      return Boolean(textPlain.trim());
    })
    .slice(0, 5)
    .map((c) => c.id);
  const prompt = [header, ...lines].join("\n");
  log.debug(LOG_NAMESPACE_COMMENTS, "Built comments prompt", { count: comments.length, promptChars: prompt.length });
  return { prompt, sampleIds };
}

export function preserveMarkdownWhitespace(content: string): string {
  const normalized = content ? content.replaceAll(/\r\n?/gu, "\n") : "";
  const lines = normalized.split("\n");
  const outLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      outLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      outLines.push(line);
    } else {
      const body = line.trimEnd();
      const trailing = line.slice(body.length);

      if (trailing.length > 2) {
        outLines.push(`${body}  `); // Trim to 2
      } else {
        outLines.push(line); // Keep as is if <= 2
      }
    }
  }
  return outLines.join("\n");
}

const LLM_ARTIFACT_BEGIN_OF_SENTENCE = "<｜begin▁of▁sentence｜>";

function sanitizeLlmContent(content: string): string {
  const preserved = preserveMarkdownWhitespace(content);
  const withoutArtifacts = preserved.replaceAll(LLM_ARTIFACT_BEGIN_OF_SENTENCE, "");
  return withoutArtifacts.trim();
}

type LlmResult = { content: string; modelUsed: string };

function classifyOpenRouterError(
  error: unknown,
  attempt: "fallback" | "primary",
  model: string,
  context: LlmLogContext
): LlmCallError | RateLimitError {
  if (error instanceof RateLimitError) {
    return error;
  }

  const httpError = error instanceof HttpError ? error : undefined;
  if (httpError && httpError.status === 429) {
    const details = extractRateLimitDetails(httpError) ?? {};
    return new RateLimitError({ model, ...details }, { cause: ensureError(error) });
  }

  if (error instanceof Error && /HTTP\s+429/u.test(error.message)) {
    return new RateLimitError({ model }, { cause: ensureError(error) });
  }

  return new LlmCallError(attempt, model, context, { cause: ensureError(error) });
}

async function callOpenRouterAttempt(
  services: Services,
  messages: ChatMessage[],
  model: string,
  attempt: "fallback" | "primary",
  context: LlmLogContext
): Promise<LlmResult> {
  const logContext = { model, ...context };
  const logMessage = attempt === "primary" ? "Calling LLM" : "Calling fallback LLM";
  log.info(LOG_NAMESPACE_LLM, logMessage, logContext);
  try {
    const content = await services.openrouter.chat(messages, {
      temperature: 0.3,
      maxTokens: env.OPENROUTER_MAX_TOKENS,
      model,
    });
    const cleaned = sanitizeLlmContent(content);
    if (attempt === "primary") {
      log.debug(LOG_NAMESPACE_LLM, "LLM response received", {
        summaryChars: cleaned.length,
        ...logContext,
      });
    } else {
      log.info(LOG_NAMESPACE_LLM, "Fallback LLM response received", {
        summaryChars: cleaned.length,
        ...logContext,
      });
    }
    return { content: cleaned, modelUsed: model };
  } catch (rawError) {
    throw classifyOpenRouterError(rawError, attempt, model, context);
  }
}

async function callOpenRouterWithRetry(
  services: Services,
  messages: ChatMessage[],
  context: LlmLogContext
): Promise<LlmResult> {
  const { OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL, OPENROUTER_FALLBACK_MODEL_2 } = env;
  let primaryFailure: LlmCallError | RateLimitError | undefined;
  let fallbackFailure: LlmCallError | RateLimitError | undefined;

  try {
    return await callOpenRouterAttempt(services, messages, OPENROUTER_MODEL, "primary", context);
  } catch (error) {
    if (error instanceof RateLimitError) {
      primaryFailure = error;
      log.warn(LOG_NAMESPACE_LLM, "Rate limit on primary model; trying fallback", {
        primary: OPENROUTER_MODEL,
        fallback: OPENROUTER_FALLBACK_MODEL,
        ...error.toLogMeta(context),
      });
    } else if (error instanceof LlmCallError) {
      primaryFailure = error;
      log.warn(LOG_NAMESPACE_LLM, "Primary model failed; trying fallback", {
        primary: OPENROUTER_MODEL,
        fallback: OPENROUTER_FALLBACK_MODEL,
        ...context,
        error: error.cause instanceof Error ? error.cause.message : error.message,
      });
    } else {
      throw error;
    }
  }

  try {
    return await callOpenRouterAttempt(services, messages, OPENROUTER_FALLBACK_MODEL, "fallback", context);
  } catch (error) {
    if (error instanceof RateLimitError) {
      fallbackFailure = error;
      log.warn(LOG_NAMESPACE_LLM, "Rate limit on first fallback; trying second fallback", {
        primary: OPENROUTER_MODEL,
        fallback: OPENROUTER_FALLBACK_MODEL,
        fallback2: OPENROUTER_FALLBACK_MODEL_2,
        ...error.toLogMeta(context),
      });
    } else if (error instanceof LlmCallError) {
      fallbackFailure = error;
      log.warn(LOG_NAMESPACE_LLM, "First fallback model failed; trying second fallback", {
        primary: OPENROUTER_MODEL,
        fallback: OPENROUTER_FALLBACK_MODEL,
        fallback2: OPENROUTER_FALLBACK_MODEL_2,
        ...context,
        error: error.cause instanceof Error ? error.cause.message : error.message,
      });
    } else {
      throw error;
    }
  }

  try {
    return await callOpenRouterAttempt(services, messages, OPENROUTER_FALLBACK_MODEL_2, "fallback", context);
  } catch (error) {
    if (error instanceof RateLimitError) {
      log.error(LOG_NAMESPACE_LLM, "Rate limit on all models", {
        primary: OPENROUTER_MODEL,
        fallback: OPENROUTER_FALLBACK_MODEL,
        fallback2: OPENROUTER_FALLBACK_MODEL_2,
        ...error.toLogMeta(context),
      });
      throw error;
    }
    if (error instanceof LlmCallError) {
      const fallback2Failure = error;
      log.error(LOG_NAMESPACE_LLM, "All models failed", {
        primary: OPENROUTER_MODEL,
        fallback: OPENROUTER_FALLBACK_MODEL,
        fallback2: OPENROUTER_FALLBACK_MODEL_2,
        ...context,
        primaryError: primaryFailure instanceof LlmCallError ? primaryFailure.describe() : primaryFailure.message,
        fallbackError: fallbackFailure instanceof LlmCallError ? fallbackFailure.describe() : fallbackFailure.message,
        fallback2Error: fallback2Failure.describe(),
      });
      throw new AggregateError(
        [
          primaryFailure instanceof LlmCallError ? primaryFailure.toError() : primaryFailure,
          fallbackFailure instanceof LlmCallError ? fallbackFailure.toError() : fallbackFailure,
          fallback2Failure.toError(),
        ].filter(Boolean),
        `LLM call failed for primary model ${OPENROUTER_MODEL}, fallback model ${OPENROUTER_FALLBACK_MODEL}, and second fallback model ${OPENROUTER_FALLBACK_MODEL_2}`
      );
    }
    throw error;
  }
}

async function callLLM(services: Services, prompt: string): Promise<LlmResult> {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const context: LlmLogContext = { promptChars: prompt.length };
  return await callOpenRouterWithRetry(services, messages, context);
}

async function callLLMWithMessages(
  services: Services,
  messages: ChatMessage[],
  context: LlmLogContext = {}
): Promise<LlmResult> {
  const ctx: LlmLogContext = { messages: messages.length, ...context };
  return await callOpenRouterWithRetry(services, messages, ctx);
}

export function buildPostChatMessages(articleSlice: string, options: { strict?: boolean } = {}): ChatMessage[] {
  const system = buildPostSystemInstruction(options.strict ?? false);
  return [
    { role: "system", content: system },
    { role: "user", content: articleSlice },
  ];
}

export async function summarizePost(
  services: Services,
  story: NormalizedStory,
  articleSlice: string,
  options: SummarizePostOptions = {}
): Promise<Pick<PostSummary, "id" | "lang" | "model" | "summary">> {
  const messages = buildPostChatMessages(articleSlice, { strict: options.strictSystem ?? false });
  const context: LlmLogContext = { ...(options.context ?? {}) };
  if (options.strictSystem !== undefined) {
    context["strict"] = options.strictSystem;
  }
  const { content, modelUsed } = await callLLMWithMessages(services, messages, context);
  return { id: story.id, lang: env.SUMMARY_LANG, summary: content, model: modelUsed };
}

export async function generateValidatedPostSummary(
  services: Services,
  story: NormalizedStory,
  articleSlice: string
): Promise<PostSummaryValidated | undefined> {
  const lang = env.SUMMARY_LANG;
  const attemptContextBase = { storyId: story.id };

  for (const attempt of POST_SUMMARY_ATTEMPTS) {
    try {
      const summaryContent = await summarizePost(services, story, articleSlice, {
        strictSystem: attempt.strict,
        context: { ...attemptContextBase, attempt: attempt.label },
      });

      const heuristics = checkSummaryHeuristics(summaryContent.summary, {
        minChars: env.POST_SUMMARY_MIN_CHARS,
        language: lang,
      });

      if (!heuristics.ok) {
        log.warn(LOG_NAMESPACE_GUARD, "Heuristic check failed", {
          id: story.id,
          attempt: attempt.label,
          triggers: heuristics.triggers,
        });
        continue;
      }

      let guardResult: SummaryGuardResult | undefined;
      if (env.POST_GUARD_ENABLE) {
        const guardModels = [env.POST_GUARD_MODEL, env.POST_GUARD_FALLBACK_MODEL].filter(
          (model, idx, arr) => model && arr.indexOf(model) === idx
        );

        for (const guardModel of guardModels) {
          try {
            guardResult = await runSummaryGuard(services.openrouter, {
              summary: summaryContent.summary,
              articleSlice,
              envLike: {
                SUMMARY_LANG: lang,
                POST_GUARD_MODEL: guardModel,
                POST_GUARD_MAX_TOKENS: env.POST_GUARD_MAX_TOKENS,
                POST_GUARD_MIN_CONFIDENCE: env.POST_GUARD_MIN_CONFIDENCE,
                POST_GUARD_ARTICLE_MAX_CHARS: env.POST_GUARD_ARTICLE_MAX_CHARS,
              },
            });
            break;
          } catch (error) {
            log.error(LOG_NAMESPACE_GUARD, "Guard call failed", {
              id: story.id,
              attempt: attempt.label,
              guardModel,
              error: String(error),
            });
          }
        }

        if (guardResult === undefined) {
          log.warn(LOG_NAMESPACE_GUARD, "Guard unavailable; accepting heuristics-only summary", {
            id: story.id,
            attempt: attempt.label,
            guardModels,
          });
        }

        if (guardResult !== undefined && !guardResult.ok) {
          log.warn(LOG_NAMESPACE_GUARD, "Guard rejected summary", {
            id: story.id,
            attempt: attempt.label,
            verdict: guardResult.verdict,
            reasons: guardResult.reasons,
            confidence: guardResult.confidence,
          });
          continue;
        }
      }

      return {
        summary: summaryContent.summary,
        modelUsed: summaryContent.model ?? env.OPENROUTER_MODEL,
        ...(guardResult !== undefined && { guard: guardResult }),
      };
    } catch (error) {
      log.error(LOG_NAMESPACE_POST, "Post summary attempt failed", {
        id: story.id,
        attempt: attempt.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.error(LOG_NAMESPACE_GUARD, "Exhausted summary attempts; skipping", { id: story.id });
  return undefined;
}

export async function summarizeComments(
  services: Services,
  storyId: number,
  prompt: string,
  sampleIds: number[] = []
): Promise<Pick<CommentsSummary, "id" | "lang" | "model" | "sampleComments" | "summary">> {
  const { content, modelUsed } = await callLLM(services, prompt);
  return {
    id: storyId,
    lang: env.SUMMARY_LANG,
    summary: content,
    sampleComments: sampleIds,
    model: modelUsed,
  };
}

export async function getOrFetchArticleMarkdown(
  services: Services,
  story: NormalizedStory,
  store: ObjectStore
): Promise<string | undefined> {
  if (!story.url) {
    log.warn(LOG_NAMESPACE_ARTICLE, "Story has no URL; cannot fetch article", { id: story.id });
    return undefined;
  }
  const path = pathFor.articleMd(story.id);
  const cached = await store.getText(path);
  if (cached?.trim()) {
    log.debug(LOG_NAMESPACE_ARTICLE, "Using cached content", { id: story.id, path });
    return cached;
  }
  try {
    log.info(LOG_NAMESPACE_ARTICLE, "Fetching article and processing content", { id: story.id, url: story.url });
    const md = await services.fetchArticleMarkdown(story.url);
    const text = md.trim();
    if (!text) {
      log.warn(LOG_NAMESPACE_ARTICLE, "Fetched content is empty", { id: story.id, url: story.url });
      return undefined;
    }
    await store.putText(path, text, { contentType: "text/markdown" });
    log.debug(LOG_NAMESPACE_ARTICLE, "Wrote content cache", { id: story.id, path });
    return text;
  } catch (error) {
    log.error(LOG_NAMESPACE_ARTICLE, "Failed to fetch content", {
      id: story.id,
      url: story.url,
      error: String(error),
    });
    return undefined;
  }
}

// Local-only variant: do not hit network; used during pre-selection phase
async function getCachedArticleMarkdownOnly(story: NormalizedStory, store: ObjectStore): Promise<string | undefined> {
  if (!story.url) {
    return undefined;
  }
  const path = pathFor.articleMd(story.id);
  const cached = await store.getText(path);
  return cached?.trim() ? cached : undefined;
}

async function processPostSummary(
  services: Services,
  story: NormalizedStory,
  postPath: string,
  store: ObjectStore
): Promise<void> {
  const existingPostSummary = await readJsonSafeOrStore(store, postPath, PostSummarySchema);

  if (env.POST_SUMMARY_ONLY_IF_MISSING && existingPostSummary) {
    log.debug(LOG_NAMESPACE_POST, "Post summary exists; skipping due to ONLY_IF_MISSING", { id: story.id });
    return;
  }

  const articleMd = await getOrFetchArticleMarkdown(services, story, store);
  const postArticleSlice = await buildPostPrompt(story, articleMd);
  const postInputHash = await hashString(`${env.SUMMARY_LANG}|${postArticleSlice}`);

  if (existingPostSummary?.inputHash === postInputHash) {
    log.debug(LOG_NAMESPACE_POST, "Post summary up-to-date; skipping", { id: story.id });
    return;
  }

  if (postArticleSlice.length > 0) {
    const validated = await generateValidatedPostSummary(services, story, postArticleSlice);
    if (!validated) {
      log.error(LOG_NAMESPACE_POST, "Post summary rejected after all attempts", {
        id: story.id,
      });
      return;
    }

    const guardPersisted = validated.guard
      ? {
          ok: validated.guard.ok,
          verdict: validated.guard.verdict,
          reasons: validated.guard.reasons,
          confidence: validated.guard.confidence,
        }
      : undefined;

    const postSummary: PostSummary = {
      id: story.id,
      lang: env.SUMMARY_LANG,
      summary: validated.summary,
      inputHash: postInputHash,
      model: validated.modelUsed,
      createdISO: new Date().toISOString(),
      ...(guardPersisted ? { guard: guardPersisted } : {}),
    };
    await store.putJson(postPath, postSummary, { pretty: true, contentType: "application/json" });
    log.info(LOG_NAMESPACE_POST, "Post summary written", {
      id: story.id,
      chars: postSummary.summary.length,
      model: validated.modelUsed,
      guardVerdict: guardPersisted?.verdict,
    });
  } else {
    log.warn(LOG_NAMESPACE_POST, "Empty post prompt; skipping LLM", { id: story.id });
  }
}

async function processCommentsSummary(
  services: Services,
  story: NormalizedStory,
  comments: NormalizedComment[],
  commentsPath: string,
  store: ObjectStore
): Promise<void> {
  const { prompt: commentsPrompt, sampleIds } = await buildCommentsPrompt(comments);
  const commentsInputHash = await hashString(commentsPrompt);
  const existingCommentsSummary = await readJsonSafeOrStore(store, commentsPath, CommentsSummarySchema);

  if (existingCommentsSummary?.inputHash === commentsInputHash) {
    log.debug(LOG_NAMESPACE_COMMENTS, "Comments summary up-to-date; skipping", { id: story.id });
    return;
  }

  if (comments.length > 0) {
    const summaryContent = await summarizeComments(services, story.id, commentsPrompt, sampleIds);
    const modelUsed = summaryContent.model ?? env.OPENROUTER_MODEL;
    const commentsSummary: CommentsSummary = {
      ...summaryContent,
      inputHash: commentsInputHash,
      model: modelUsed,
      createdISO: new Date().toISOString(),
    };
    await store.putJson(commentsPath, commentsSummary, { pretty: true, contentType: "application/json" });
    log.info(LOG_NAMESPACE_COMMENTS, "Comments summary written", {
      id: story.id,
      chars: commentsSummary.summary.length,
      model: modelUsed,
    });
  } else {
    log.warn(LOG_NAMESPACE_COMMENTS, "No comments available; skipping summary", { id: story.id });
  }
}

async function processTags(
  services: Services,
  story: NormalizedStory,
  postSummary: string | undefined,
  commentsSummary: string | undefined,
  store: ObjectStore
): Promise<void> {
  // Allow disabling tags to conserve LLM quota (e.g., during catch-up runs)
  if (env.TAGS_MAX_PER_STORY <= 0) {
    log.debug(TAGS_DEBUG_MESSAGE, "tags disabled via TAGS_MAX_PER_STORY=0", { id: story.id });
    return;
  }
  const p = pathFor.tagsSummary(story.id);
  const prompt = buildTagsPrompt(story, postSummary, commentsSummary);
  const inputHash = await hashString(`tags|${prompt}|${env.TAGS_MODEL}`);
  const existing = await readJsonSafeOrStore(store, p, TagsSummarySchema);
  if (existing?.inputHash === inputHash) {
    log.debug(TAGS_DEBUG_MESSAGE, "up-to-date", { id: story.id });
    return;
  }

  try {
    const llm = await summarizeTagsStructured(services.openrouter, prompt, env);
    const domain = story.url ? new URL(story.url).hostname : undefined;
    const tags = combineAndCanon({
      llm,
      title: story.title,
      domain,
      max: env.TAGS_MAX_PER_STORY,
    });

    const payload = {
      id: story.id,
      lang: env.TAGS_LANG,
      tags: tags.map((slug) => ({ name: slug })), // store normalized names in summary for transparency
      inputHash,
      model: env.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };
    await store.putJson(p, payload, { pretty: true, contentType: "application/json" });
    log.info(TAGS_DEBUG_MESSAGE, "tags written", { id: story.id, count: tags.length, model: env.TAGS_MODEL });
  } catch (error) {
    log.error(TAGS_DEBUG_MESSAGE, "Failed to generate structured tags, falling back to heuristics", {
      id: story.id,
      error,
      model: env.TAGS_MODEL,
    });

    // Fallback to just heuristic tags if structured output fails
    const domain = story.url ? new URL(story.url).hostname : undefined;
    const tags = combineAndCanon({
      llm: [],
      title: story.title,
      domain,
      max: env.TAGS_MAX_PER_STORY,
    });

    const payload = {
      id: story.id,
      lang: env.TAGS_LANG,
      tags: tags.map((name) => ({ name })),
      inputHash,
      model: env.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };
    await store.putJson(p, payload, { pretty: true, contentType: "application/json" });
    log.info(TAGS_DEBUG_MESSAGE, "fallback tags written", { id: story.id, count: tags.length, model: env.TAGS_MODEL });
  }
}

export async function processSingleStory(
  services: Services,
  id: number,
  store: ObjectStore
): Promise<void> {
  const story = await readJsonSafeOrStore<NormalizedStory>(
    store,
    pathFor.rawItem(id),
    NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
  );
  if (!story) {
    log.warn("summarize", "Missing normalized story file; skipping", { id });
    return;
  }

  const comments = await readJsonSafeOrStore<NormalizedComment[]>(
    store,
    pathFor.rawComments(id),
    NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
    []
  );
  log.debug(LOG_NAMESPACE_COMMENTS, "Comments loaded", { id: story.id, count: comments.length });

  const postPath = pathFor.postSummary(id);
  const commentsPath = pathFor.commentsSummary(id);

  await processPostSummary(services, story, postPath, store);
  await publishTelegramAfterSummary(services, story, store);
  await processCommentsSummary(services, story, comments, commentsPath, store);

  const post = await readJsonSafeOrStore(store, pathFor.postSummary(story.id), PostSummarySchema);
  const commentsSummary = await readJsonSafeOrStore(store, pathFor.commentsSummary(story.id), CommentsSummarySchema);
  await processTags(services, story, post?.summary, commentsSummary?.summary, store);
}

type Candidate = {
  id: number;
  priority: number;
  timeISO?: string;
};

type CandidateSelectionConfig = {
  cooldownMs: number;
  summaryLang: string;
  postSummaryOnlyIfMissing: boolean;
};

function isInsideCooldown(iso: string | undefined, now: number, cooldownMs: number): boolean {
  if (!iso || cooldownMs <= 0) {
    return false;
  }
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && now - ts < cooldownMs;
}

async function computePostChanged(
  story: NormalizedStory,
  existingPost: PostSummary | null | undefined,
  config: CandidateSelectionConfig,
  now: number,
  store: ObjectStore
): Promise<boolean> {
  if (!existingPost) {
    return true;
  }
  if (config.postSummaryOnlyIfMissing) {
    return false;
  }
  if (isInsideCooldown(existingPost.createdISO, now, config.cooldownMs)) {
    return false;
  }
  const cachedMd = await getCachedArticleMarkdownOnly(story, store);
  if (!cachedMd) {
    return false;
  }
  const slice = await buildPostPrompt(story, cachedMd);
  const hash = await hashString(`${config.summaryLang}|${slice}`);
  return existingPost.inputHash !== hash;
}

async function computeCommentsChanged(
  id: number,
  existingComments: CommentsSummary | null | undefined,
  cooldownMs: number,
  now: number,
  store: ObjectStore
): Promise<boolean> {
  if (!existingComments) {
    return true;
  }
  if (isInsideCooldown(existingComments.createdISO, now, cooldownMs)) {
    return false;
  }
  const comments = await readJsonSafeOrStore<NormalizedComment[]>(
    store,
    pathFor.rawComments(id),
    NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
    []
  );
  const { prompt } = await buildCommentsPrompt(comments);
  const hash = await hashString(prompt);
  return existingComments.inputHash !== hash;
}

async function evaluateCandidate(
  id: number,
  config: CandidateSelectionConfig,
  store: ObjectStore
): Promise<Candidate | undefined> {
  const story = await readJsonSafeOrStore<NormalizedStory>(
    store,
    pathFor.rawItem(id),
    NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
  );
  if (!story) {
    return undefined;
  }

  const [existingPost, existingComments] = await Promise.all([
    readJsonSafeOrStore(store, pathFor.postSummary(id), PostSummarySchema.nullable()),
    readJsonSafeOrStore(store, pathFor.commentsSummary(id), CommentsSummarySchema.nullable()),
  ]);

  const now = Date.now();
  const postChanged = await computePostChanged(story, existingPost, config, now, store);
  const commentsChanged = await computeCommentsChanged(id, existingComments, config.cooldownMs, now, store);
  const priority = (postChanged ? 1 : 0) + (commentsChanged ? 2 : 0);

  if (priority <= 0) {
    return undefined;
  }

  return { id, priority, timeISO: story.timeISO };
}

async function collectCandidates(
  ids: number[],
  config: CandidateSelectionConfig,
  store: ObjectStore
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const id of ids) {
    try {
      const candidate = await evaluateCandidate(id, config, store);
      if (candidate) {
        candidates.push(candidate);
      }
    } catch (error) {
      log.warn("summarize", "Preselect failed; will attempt full processing", { id, error: String(error) });
      candidates.push({ id, priority: 1 });
    }
  }
  return candidates;
}

export async function summarizeWorkflow(services: Services, e: Env, store: ObjectStore): Promise<void> {
  const index = await readJsonSafeOrStore<{ updatedISO: string; storyIds: number[] }>(store, PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const {
    OPENROUTER_API_KEY,
    SUMMARIZE_COOLDOWN_MINUTES,
    SUMMARIZE_MAX_STORIES_PER_RUN,
    POST_SUMMARY_ONLY_IF_MISSING,
    SUMMARY_LANG,
  } = e;
  if (!OPENROUTER_API_KEY) {
    log.warn("summarize", "OPENROUTER_API_KEY missing; skipping summarize step");
    return;
  }

  // Pre-select candidates to limit token burn per run
  const cooldownMins = Math.max(0, SUMMARIZE_COOLDOWN_MINUTES);
  const maxPerRun = Math.max(1, SUMMARIZE_MAX_STORIES_PER_RUN);
  const candidates = await collectCandidates(index.storyIds, {
    cooldownMs: cooldownMins * 60_000,
    summaryLang: SUMMARY_LANG,
    postSummaryOnlyIfMissing: POST_SUMMARY_ONLY_IF_MISSING,
  }, store);

  // Sort: higher priority first; then newest by timeISO desc; then id desc
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    const ta = a.timeISO ? Date.parse(a.timeISO) : Number.NaN;
    const tb = b.timeISO ? Date.parse(b.timeISO) : Number.NaN;
    const aHas = Number.isFinite(ta);
    const bHas = Number.isFinite(tb);
    if (aHas && bHas) {
      return tb - ta;
    }
    if (aHas && !bHas) {
      return -1;
    }
    if (!aHas && bHas) {
      return 1;
    }
    return b.id - a.id;
  });

  const selected = candidates.slice(0, maxPerRun);
  const skipped = Math.max(0, candidates.length - selected.length);
  if (skipped > 0) {
    log.info("summarize", "Cap reached; skipping some stories this run", {
      candidates: candidates.length,
      selected: selected.length,
      skipped,
      maxPerRun,
      cooldownMins,
    });
  }

  let rateLimitAbort: RateLimitError | undefined;

  for (const { id } of selected) {
    if (rateLimitAbort) {
      log.warn("summarize", "Skipping story due to prior rate limit", {
        id,
        retryISO: rateLimitAbort.retryDate?.toISOString(),
        model: rateLimitAbort.model,
      });
      break;
    }
    log.info("summarize", "Processing story", { id });
    try {
      await processSingleStory(services, id, store);
    } catch (error) {
      if (error instanceof RateLimitError) {
        rateLimitAbort = error;
        log.error("summarize", "Aborting summarize run due to OpenRouter rate limit", {
          id,
          ...error.toLogMeta(),
        });
        break;
      }
      log.error("summarize", "Unhandled error during story processing", { id, error: String(error) });
      continue;
    }
  }

  if (rateLimitAbort) {
    log.warn("summarize", "Summarize run aborted early because of rate limit", rateLimitAbort.toLogMeta());
  }
}
