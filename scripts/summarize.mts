import { createHash } from "node:crypto";
import { dirname } from "node:path";


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
import { ensureDir, readTextSafe, writeTextFile } from "@utils/fs";
import { htmlToMd } from "@utils/html-to-md";
import { HttpClient } from "@utils/http-client";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";
import { OpenRouter, type ChatMessage } from "@utils/openrouter";
import { buildTagsPrompt, combineAndCanon, summarizeTagsStructured } from "@utils/tags-extract";

import type { z } from "zod";

export type Services = {
  http: HttpClient;
  openrouter: OpenRouter;
  fetchArticleMarkdown: (url: string) => Promise<string>;
};

export function makeServices(e: Env): Services {
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
    const html = await http.text(url);
    return htmlToMd(html);
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

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function buildPostSystemInstruction(): string {
  return env.SUMMARY_LANG === "en"
    ? "make the content two times shorter, don't mention the title, publication date and other metadata; format the output as markdown"
    : "переведи на русский содержимое (не указывай заголовок, дату и другие метаданные), сократи в два раза; форматируй вывод как markdown";
}

function buildCommentsLanguageHeader(): string {
  if (env.SUMMARY_LANG === "en") {
    return "Language: en\nSummarize the discussion in 5-7 sentences or fewer. Use bullet points.";
  }
  return "Language: ru\nСделай саммари обсуждения в 5-7 предложениях или меньше. Твой ответ должен быть на русском языке. Используй bullet points.";
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

async function callLLM(services: Services, prompt: string): Promise<string> {
  try {
    const { OPENROUTER_MODEL, OPENROUTER_MAX_TOKENS } = env;
    log.info(LOG_NAMESPACE_LLM, "Calling LLM", { model: OPENROUTER_MODEL, promptChars: prompt.length });
    const content = await services.openrouter.chat([{ role: "user", content: prompt }], {
      temperature: 0.3,
      maxTokens: OPENROUTER_MAX_TOKENS,
    });
    const cleaned = preserveMarkdownWhitespace(content).trim();
    log.debug(LOG_NAMESPACE_LLM, "LLM response received", { summaryChars: cleaned.length });
    return cleaned;
  } catch (error) {
    log.error(LOG_NAMESPACE_LLM, "OpenRouter call failed", { error: String(error) });
    throw error;
  }
}

async function callLLMWithMessages(services: Services, messages: ChatMessage[]): Promise<string> {
  try {
    const { OPENROUTER_MODEL, OPENROUTER_MAX_TOKENS } = env;
    log.info(LOG_NAMESPACE_LLM, "Calling LLM", { model: OPENROUTER_MODEL, messages: messages.length });
    const content = await services.openrouter.chat(messages, {
      temperature: 0.3,
      maxTokens: OPENROUTER_MAX_TOKENS,
    });
    const cleaned = preserveMarkdownWhitespace(content).trim();
    log.debug(LOG_NAMESPACE_LLM, "LLM response received", { summaryChars: cleaned.length });
    return cleaned;
  } catch (error) {
    log.error(LOG_NAMESPACE_LLM, "OpenRouter call failed", { error: String(error) });
    throw error;
  }
}

export function buildPostChatMessages(articleSlice: string): ChatMessage[] {
  const system = buildPostSystemInstruction();
  return [
    { role: "system", content: system },
    { role: "user", content: articleSlice },
  ];
}

export async function summarizePost(
  services: Services,
  story: NormalizedStory,
  articleSlice: string
): Promise<Pick<PostSummary, "id" | "lang" | "summary">> {
  const messages = buildPostChatMessages(articleSlice);
  const summary = await callLLMWithMessages(services, messages);
  return { id: story.id, lang: env.SUMMARY_LANG, summary };
}

export async function summarizeComments(
  services: Services,
  storyId: number,
  prompt: string,
  sampleIds: number[] = []
): Promise<Pick<CommentsSummary, "id" | "lang" | "sampleComments" | "summary">> {
  const summary = await callLLM(services, prompt);
  return { id: storyId, lang: env.SUMMARY_LANG, summary, sampleComments: sampleIds };
}

export async function getOrFetchArticleMarkdown(
  services: Services,
  story: NormalizedStory
): Promise<string | undefined> {
  if (!story.url) {
    log.warn(LOG_NAMESPACE_ARTICLE, "Story has no URL; cannot fetch article", { id: story.id });
    return undefined;
  }
  const path = pathFor.articleMd(story.id);
  const cached = await readTextSafe(path);
  if (cached?.trim()) {
    log.debug(LOG_NAMESPACE_ARTICLE, "Using cached markdown", { id: story.id, path });
    return cached;
  }
  try {
    await ensureDir(dirname(path));
    log.info(LOG_NAMESPACE_ARTICLE, "Fetching article and converting via Turndown", { id: story.id, url: story.url });
    const md = await services.fetchArticleMarkdown(story.url);
    const text = md.trim();
    if (!text) {
      log.warn(LOG_NAMESPACE_ARTICLE, "Fetched markdown is empty", { id: story.id, url: story.url });
      return undefined;
    }
    await writeTextFile(path, text);
    log.debug(LOG_NAMESPACE_ARTICLE, "Wrote markdown cache", { id: story.id, path });
    return text;
  } catch (error) {
    log.error(LOG_NAMESPACE_ARTICLE, "Failed to fetch markdown", {
      id: story.id,
      url: story.url,
      error: String(error),
    });
    return undefined;
  }
}

async function processPostSummary(services: Services, story: NormalizedStory, postPath: string): Promise<void> {
  const articleMd = await getOrFetchArticleMarkdown(services, story);
  const postArticleSlice = await buildPostPrompt(story, articleMd);
  const postInputHash = hashString(`${env.SUMMARY_LANG}|${postArticleSlice}`);
  const existingPostSummary = await readJsonSafeOr(postPath, PostSummarySchema);

  if (existingPostSummary?.inputHash === postInputHash) {
    log.debug(LOG_NAMESPACE_POST, "Post summary up-to-date; skipping", { id: story.id });
    return;
  }

  if (postArticleSlice.length > 0) {
    const summaryContent = await summarizePost(services, story, postArticleSlice);
    const { OPENROUTER_MODEL } = env;
    const postSummary: PostSummary = {
      ...summaryContent,
      inputHash: postInputHash,
      model: OPENROUTER_MODEL,
      createdISO: new Date().toISOString(),
    };
    await writeJsonFile(postPath, postSummary, { atomic: true, pretty: true });
    log.info(LOG_NAMESPACE_POST, "Post summary written", {
      id: story.id,
      chars: postSummary.summary.length,
      model: OPENROUTER_MODEL,
    });
  } else {
    log.warn(LOG_NAMESPACE_POST, "Empty post prompt; skipping LLM", { id: story.id });
  }
}

async function processCommentsSummary(
  services: Services,
  story: NormalizedStory,
  comments: NormalizedComment[],
  commentsPath: string
): Promise<void> {
  const { prompt: commentsPrompt, sampleIds } = await buildCommentsPrompt(comments);
  const commentsInputHash = hashString(commentsPrompt);
  const existingCommentsSummary = await readJsonSafeOr(commentsPath, CommentsSummarySchema);

  if (existingCommentsSummary?.inputHash === commentsInputHash) {
    log.debug(LOG_NAMESPACE_COMMENTS, "Comments summary up-to-date; skipping", { id: story.id });
    return;
  }

  if (comments.length > 0) {
    const summaryContent = await summarizeComments(services, story.id, commentsPrompt, sampleIds);
    const { OPENROUTER_MODEL } = env;
    const commentsSummary: CommentsSummary = {
      ...summaryContent,
      inputHash: commentsInputHash,
      model: OPENROUTER_MODEL,
      createdISO: new Date().toISOString(),
    };
    await writeJsonFile(commentsPath, commentsSummary, { atomic: true, pretty: true });
    log.info(LOG_NAMESPACE_COMMENTS, "Comments summary written", {
      id: story.id,
      chars: commentsSummary.summary.length,
      model: OPENROUTER_MODEL,
    });
  } else {
    log.warn(LOG_NAMESPACE_COMMENTS, "No comments available; skipping summary", { id: story.id });
  }
}

async function processTags(
  services: Services,
  story: NormalizedStory,
  postSummary?: string,
  commentsSummary?: string
): Promise<void> {
  const p = pathFor.tagsSummary(story.id);
  const prompt = buildTagsPrompt(story, postSummary, commentsSummary);
  const inputHash = hashString(`tags|${prompt}|${env.TAGS_MODEL}`);
  const existing = await readJsonSafeOr(p, TagsSummarySchema);
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
    await writeJsonFile(p, payload, { atomic: true, pretty: true });
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
    await writeJsonFile(p, payload, { atomic: true, pretty: true });
    log.info(TAGS_DEBUG_MESSAGE, "fallback tags written", { id: story.id, count: tags.length, model: env.TAGS_MODEL });
  }
}

async function processSingleStory(services: Services, id: number): Promise<void> {
  const story = await readJsonSafeOr<NormalizedStory>(
    pathFor.rawItem(id),
    NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
  );
  if (!story) {
    log.warn("summarize", "Missing normalized story file; skipping", { id });
    return;
  }

  const comments = await readJsonSafeOr<NormalizedComment[]>(
    pathFor.rawComments(id),
    NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
    []
  );
  log.debug(LOG_NAMESPACE_COMMENTS, "Comments loaded", { id: story.id, count: comments.length });

  const postPath = pathFor.postSummary(id);
  const commentsPath = pathFor.commentsSummary(id);

  await processPostSummary(services, story, postPath);
  await processCommentsSummary(services, story, comments, commentsPath);

  const post = await readJsonSafeOr(pathFor.postSummary(story.id), PostSummarySchema);
  const commentsSummary = await readJsonSafeOr(pathFor.commentsSummary(story.id), CommentsSummarySchema);
  await processTags(services, story, post?.summary, commentsSummary?.summary);
}

export async function summarizeWorkflow(services: Services, e: Env = env): Promise<void> {
  const index = await readJsonSafeOr<{ updatedISO: string; storyIds: number[] }>(PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  const { OPENROUTER_API_KEY } = e;
  if (!OPENROUTER_API_KEY) {
    log.warn("summarize", "OPENROUTER_API_KEY missing; skipping summarize step");
    return;
  }

  for (const id of index.storyIds) {
    log.info("summarize", "Processing story", { id });
    try {
      await processSingleStory(services, id);
    } catch (error) {
      log.error("summarize", "Unhandled error during story processing", { id, error: String(error) });
      continue;
    }
  }
}

async function main(): Promise<void> {
  const services = makeServices(env);
  await summarizeWorkflow(services, env);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
