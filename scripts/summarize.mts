import { env, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import type { CommentsSummary, NormalizedComment, NormalizedStory, PostSummary } from "@config/schemas";
import {
  CommentsSummarySchema,
  IndexSchema,
  NormalizedCommentSchema,
  NormalizedStorySchema,
  PostSummarySchema,
} from "@config/schemas";
import { ensureDir, readTextSafe, writeTextFile } from "@utils/fs";
import { HttpClient } from "@utils/http-client";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";
import { OpenRouter, type ChatMessage } from "@utils/openrouter";
import htmlToMd from "@utils/htmlToMd";
import { createHash } from "crypto";
import { dirname } from "path";
import type { z } from "zod";

type Services = {
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

const SUMMARY_LANG = env.SUMMARY_LANG;
const ARTICLE_SLICE_CHARS = env.ARTICLE_SLICE_CHARS ?? 6000;

const LANG = SUMMARY_LANG;

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function buildPostSystemInstruction(): string {
  return LANG === "en"
    ? "make the content two times shorter, don't mention the title, publication date and other metadata; format the output as markdown"
    : "переведи на русский содержимое (не указывай заголовок, дату и другие метаданные), сократи в два раза; форматируй вывод как markdown";
}

function buildCommentsLanguageHeader(): string {
  if (LANG === "en") {
    return "Language: en\nSummarize the discussion in 5-7 sentences or fewer. Use bullet points.";
  }
  return "Language: ru\nСделай саммари обсуждения в 5-7 предложениях или меньше. Твой ответ должен быть на русском языке. Используй bullet points.";
}

export async function buildPostPrompt(story: NormalizedStory, articleMd?: string | null): Promise<string> {
  const content = (articleMd ?? "").trim();
  if (!content) {
    log.warn("summarize/post", "No article content – skipping post prompt", { id: story.id });
    return "";
  }
  const articleSlice = content.slice(0, ARTICLE_SLICE_CHARS);
  log.debug("summarize/post", "Built post prompt", { id: story.id, promptChars: articleSlice.length });
  return articleSlice;
}

export async function buildCommentsPrompt(
  comments: NormalizedComment[]
): Promise<{ prompt: string; sampleIds: number[] }> {
  const header = buildCommentsLanguageHeader();
  let budget = 6 * env.OPENROUTER_MAX_TOKENS;
  const lines: string[] = [];
  for (const c of comments) {
    const text = (c.textPlain ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `@${c.by} [d${c.depth}] ${text.slice(0, 400)}`;
    const cost = line.length + 1;
    if (budget - cost < 0) break;
    lines.push(line);
    budget -= cost;
  }
  const sampleIds = comments
    .filter((c) => (c.textPlain ?? "").trim().length > 0)
    .slice(0, 5)
    .map((c) => c.id);
  const prompt = [header, ...lines].join("\n");
  log.debug("summarize/comments", "Built comments prompt", { count: comments.length, promptChars: prompt.length });
  return { prompt, sampleIds };
}

export function preserveMarkdownWhitespace(content: string): string {
  const normalized = (content ?? "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => {
    const match = /(.*?)(\s*)$/.exec(line);
    if (!match) return line;
    const body = match[1];
    const trailing = match[2] ?? "";
    if (trailing.length === 2) return body + "  ";
    return body;
  });
  return lines.join("\n").trim();
}

async function callLLM(services: Services, prompt: string): Promise<string> {
  try {
    log.info("summarize/llm", "Calling LLM", { model: env.OPENROUTER_MODEL, promptChars: prompt.length });
    const content = await services.openrouter.chat([{ role: "user", content: prompt }], {
      temperature: 0.3,
      maxTokens: env.OPENROUTER_MAX_TOKENS,
    });
    const cleaned = preserveMarkdownWhitespace(content);
    log.debug("summarize/llm", "LLM response received", { summaryChars: cleaned.length });
    return cleaned;
  } catch (e) {
    log.error("summarize/llm", "OpenRouter call failed", { error: String(e) });
    throw e;
  }
}

async function callLLMWithMessages(services: Services, messages: ChatMessage[]): Promise<string> {
  try {
    log.info("summarize/llm", "Calling LLM", { model: env.OPENROUTER_MODEL, messages: messages.length });
    const content = await services.openrouter.chat(messages, {
      temperature: 0.3,
      maxTokens: env.OPENROUTER_MAX_TOKENS,
    });
    const cleaned = preserveMarkdownWhitespace(content);
    log.debug("summarize/llm", "LLM response received", { summaryChars: cleaned.length });
    return cleaned;
  } catch (e) {
    log.error("summarize/llm", "OpenRouter call failed", { error: String(e) });
    throw e;
  }
}

function buildPostChatMessages(articleSlice: string): ChatMessage[] {
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
  return { id: story.id, lang: SUMMARY_LANG, summary };
}

export async function summarizeComments(
  services: Services,
  storyId: number,
  prompt: string,
  sampleIds: number[] = []
): Promise<Pick<CommentsSummary, "id" | "lang" | "summary" | "sampleComments">> {
  const summary = await callLLM(services, prompt);
  return { id: storyId, lang: SUMMARY_LANG, summary, sampleComments: sampleIds };
}

export async function getOrFetchArticleMarkdown(services: Services, story: NormalizedStory): Promise<string | null> {
  if (!story.url) {
    log.warn("summarize/article", "Story has no URL; cannot fetch article", { id: story.id });
    return null;
  }
  const path = pathFor.articleMd(story.id);
  const cached = await readTextSafe(path);
  if (cached && cached.trim()) {
    log.debug("summarize/article", "Using cached markdown", { id: story.id, path });
    return cached;
  }
  try {
    await ensureDir(dirname(path));
    log.info(
      "summarize/article",
      "Fetching article and converting via Turndown",
      { id: story.id, url: story.url }
    );
    const md = await services.fetchArticleMarkdown(story.url);
    const text = md.trim();
    if (!text) {
      log.warn("summarize/article", "Fetched markdown is empty", { id: story.id, url: story.url });
      return null;
    }
    await writeTextFile(path, text);
    log.debug("summarize/article", "Wrote markdown cache", { id: story.id, path });
    return text;
  } catch (e) {
    log.error("summarize/article", "Failed to fetch markdown", { id: story.id, url: story.url, error: String(e) });
    return null;
  }
}

export async function summarizeWorkflow(services: Services): Promise<void> {
  const index = await readJsonSafeOr<{ updatedISO: string; storyIds: number[] }>(PATHS.index, IndexSchema, {
    updatedISO: new Date(0).toISOString(),
    storyIds: [],
  });

  if (!env.OPENROUTER_API_KEY) {
    log.warn("summarize", "OPENROUTER_API_KEY missing; skipping summarize step");
    return;
  }

  for (const id of index.storyIds) {
    log.info("summarize", "Processing story", { id });
    try {
      const story = await readJsonSafeOr<NormalizedStory>(
        pathFor.rawItem(id),
        NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>,
        null as unknown as NormalizedStory
      );
      if (!story) {
        log.warn("summarize", "Missing normalized story file; skipping", { id });
        continue;
      }
      const comments = await readJsonSafeOr<NormalizedComment[]>(
        pathFor.rawComments(id),
        NormalizedCommentSchema.array() as unknown as z.ZodType<NormalizedComment[]>,
        []
      );
      log.debug("summarize/comments", "Comments loaded", { id: story.id, count: comments.length });

      const postPath = pathFor.postSummary(id);
      const commentsPath = pathFor.commentsSummary(id);

      const articleMd = await getOrFetchArticleMarkdown(services, story);
      const postArticleSlice = await buildPostPrompt(story, articleMd);
      const postInputHash = hashString(`${LANG}|${postArticleSlice}`);
      const existingPostSummary = await readJsonSafeOr(postPath, PostSummarySchema, null);

      if (existingPostSummary?.inputHash === postInputHash) {
        log.debug("summarize/post", "Post summary up-to-date; skipping", { id: story.id });
      } else {
        if (postArticleSlice.length > 0) {
          const summaryContent = await summarizePost(services, story, postArticleSlice);
          const postSummary: PostSummary = {
            ...summaryContent,
            inputHash: postInputHash,
            model: env.OPENROUTER_MODEL,
            createdISO: new Date().toISOString(),
          };
          await writeJsonFile(postPath, postSummary, { atomic: true, pretty: true });
          log.info("summarize/post", "Post summary written", {
            id: story.id,
            chars: postSummary.summary.length,
            model: env.OPENROUTER_MODEL,
          });
        } else {
          log.warn("summarize/post", "Empty post prompt; skipping LLM", { id: story.id });
        }
      }

      const { prompt: commentsPrompt, sampleIds } = await buildCommentsPrompt(comments);
      const commentsInputHash = hashString(commentsPrompt);
      const existingCommentsSummary = await readJsonSafeOr(commentsPath, CommentsSummarySchema, null);

      if (existingCommentsSummary?.inputHash === commentsInputHash) {
        log.debug("summarize/comments", "Comments summary up-to-date; skipping", { id: story.id });
      } else {
        if (comments.length > 0) {
          const summaryContent = await summarizeComments(services, story.id, commentsPrompt, sampleIds);
          const commentsSummary: CommentsSummary = {
            ...summaryContent,
            inputHash: commentsInputHash,
            model: env.OPENROUTER_MODEL,
            createdISO: new Date().toISOString(),
          };
          await writeJsonFile(commentsPath, commentsSummary, { atomic: true, pretty: true });
          log.info("summarize/comments", "Comments summary written", {
            id: story.id,
            chars: commentsSummary.summary.length,
            model: env.OPENROUTER_MODEL,
          });
        } else {
          log.warn("summarize/comments", "No comments available; skipping summary", { id: story.id });
        }
      }
    } catch (e) {
      log.error("summarize", "Unhandled error during story processing", { id, error: String(e) });
      continue;
    }
  }
}

async function main(): Promise<void> {
  const services = makeServices(env);
  await summarizeWorkflow(services);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
