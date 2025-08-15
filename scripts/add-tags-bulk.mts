#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";

import { z } from "zod";

import { env, type Env } from "@config/env";
import { PATHS, pathFor } from "@config/paths";
import {
  CommentsSummarySchema,
  NormalizedStorySchema,
  PostSummarySchema,
  TagsSummarySchema,
  type NormalizedStory,
} from "@config/schemas";
import { readJsonSafeOr, writeJsonFile } from "@utils/json";
import { log } from "@utils/log";
// Remove the incorrect import since we'll define it locally
import { canonicalize, dedupeKeepOrder, heuristicTags } from "@utils/tags";

import { makeServices, type Services } from "./summarize.mts";

import type { JsonSchema } from "@utils/openrouter";

// Import the functions we need from summarize

const TAGS_DEBUG_MESSAGE = "tags-bulk";

// Hash function for input consistency checking
function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Build tags prompt from story and existing summaries
async function buildTagsPrompt(
  story: NormalizedStory,
  postSummary?: string,
  commentsSummary?: string
): Promise<string> {
  const summary = (postSummary ?? "").slice(0, 800);
  const comments = (commentsSummary ?? "").slice(0, 600);
  const domain = story.url ? new URL(story.url).hostname.replace(/^www\./u, "") : "news.ycombinator.com";
  return [
    `title: ${story.title}`,
    `domain: ${domain}`,
    `signals:`,
    summary ? `- summary: ${summary}` : undefined,
    comments ? `- comments: ${comments}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

// Zod schema for structured tags output
const TagsResponseSchema = z.object({
  tags: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        cat: z
          .enum([
            "topic",
            "lang",
            "lib",
            "framework",
            "company",
            "org",
            "product",
            "standard",
            "person",
            "event",
            "infra",
            "other",
          ])
          .optional(),
      })
    )
    .max(env.TAGS_MAX_PER_STORY),
});

type TagsResponse = z.infer<typeof TagsResponseSchema>;

// LLM-based tags generation function (copied from summarize.mts)
async function summarizeTagsStructured(
  services: Services,
  prompt: string,
  customEnv: Env
): Promise<Array<{ name: string; cat?: string | undefined }>> {
  log.debug(TAGS_DEBUG_MESSAGE, "structured request", { model: customEnv.TAGS_MODEL, promptChars: prompt.length });

  const schema: JsonSchema = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Tag name, normalized and lowercase",
            },
            cat: {
              type: "string",
              enum: [
                "topic",
                "lang",
                "lib",
                "framework",
                "company",
                "org",
                "product",
                "standard",
                "person",
                "event",
                "infra",
                "other",
              ],
              description: "Optional category for the tag",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["tags"],
    additionalProperties: false,
  };

  // Try structured outputs first
  try {
    const result = await services.openrouter.chatStructured<TagsResponse>(
      [
        {
          role: "system",
          content: `Answer in JSON. You are a technical content categorization expert. Extract only the most relevant and certain tags from the given content.

Rules:
- Only include tags you are highly confident about based on explicit mentions or clear context
- Focus on: programming languages, frameworks, databases, cloud platforms, companies, protocols, and core technical concepts
- Use lowercase, normalized names (e.g., "javascript" not "JavaScript", "postgresql" not "PostgreSQL")
- Avoid generic terms like "software", "technology", "development" unless they're the main focus
- Prefer specific over general (e.g., "reactjs" over "frontend")
- Return at most ${customEnv.TAGS_MAX_PER_STORY} tags
- Only return tags that add meaningful categorization value`,
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.5,
        maxTokens: customEnv.TAGS_MAX_TOKENS,
        model: customEnv.TAGS_MODEL,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "tags_extraction",
            strict: true,
            schema,
          },
        },
      },
      TagsResponseSchema,
      2 // reduced retries
    );

    return result.tags.map((tag: { name: string; cat?: string | undefined }) => ({
      name: tag.name,
      cat: tag.cat,
    }));
  } catch (error) {
    log.warn(TAGS_DEBUG_MESSAGE, "structured outputs failed, falling back to regular JSON", {
      model: customEnv.TAGS_MODEL,
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback to regular chat with JSON instructions
    const jsonResponse = await services.openrouter.chat(
      [
        {
          role: "system",
          content: `You are a technical content categorization expert. Extract only the most relevant and certain tags from the given content.

Return your response as valid JSON in this exact format:
{"tags": [{"name": "tag1", "cat": "category"}, {"name": "tag2"}]}

Rules:
- Only include tags you are highly confident about based on explicit mentions or clear context
- Focus on: programming languages, frameworks, databases, cloud platforms, companies, protocols, and core technical concepts
- Use lowercase, normalized names (e.g., "javascript" not "JavaScript", "postgresql" not "PostgreSQL")
- Avoid generic terms like "software", "technology", "development" unless they're the main focus
- Prefer specific over general (e.g., "reactjs" over "frontend")
- Return at most ${customEnv.TAGS_MAX_PER_STORY} tags
- Categories: topic, lang, lib, framework, company, org, product, standard, person, event, infra, other
- Category is optional, only add if certain`,
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.5,
        maxTokens: customEnv.TAGS_MAX_TOKENS,
        model: customEnv.TAGS_MODEL,
      }
    );

    // Parse the JSON response manually
    const trimmed = jsonResponse.trim();
    const parsed = JSON.parse(trimmed) as unknown;
    const validated = TagsResponseSchema.parse(parsed);

    return validated.tags.map((tag) => ({
      name: tag.name,
      cat: tag.cat,
    }));
  }
}

// Tags-only processing function
async function processTagsOnly(services: Services, story: NormalizedStory, customEnv: Env): Promise<void> {
  const p = pathFor.tagsSummary(story.id);

  // Get existing summaries if they exist
  const post = await readJsonSafeOr(pathFor.postSummary(story.id), PostSummarySchema);
  const commentsSummary = await readJsonSafeOr(pathFor.commentsSummary(story.id), CommentsSummarySchema);

  const prompt = await buildTagsPrompt(story, post?.summary, commentsSummary?.summary);
  const inputHash = hashString(`tags|${prompt}|${customEnv.TAGS_MODEL}`);
  const existing = await readJsonSafeOr(p, TagsSummarySchema);

  if (existing?.inputHash === inputHash) {
    log.debug(TAGS_DEBUG_MESSAGE, "up-to-date", { id: story.id });
    return;
  }

  try {
    // Try LLM-based tags first
    const llm = await summarizeTagsStructured(services, prompt, customEnv);
    const heur = heuristicTags(story.title, story.url ? new URL(story.url).hostname : undefined);
    const canonLlm = llm.map((tag) => canonicalize({ name: tag.name, cat: tag.cat }));
    const canonHeur = heur.map((s) => ({ slug: s }));
    const canon = [...canonLlm, ...canonHeur];
    const tags = dedupeKeepOrder(canon).slice(0, customEnv.TAGS_MAX_PER_STORY);

    const payload = {
      id: story.id,
      lang: customEnv.TAGS_LANG,
      tags: tags.map((slug) => ({ name: slug })),
      inputHash,
      model: customEnv.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };

    await writeJsonFile(p, payload, { atomic: true, pretty: true });
    log.info(TAGS_DEBUG_MESSAGE, "tags written", { id: story.id, count: tags.length, model: customEnv.TAGS_MODEL });
  } catch (error) {
    log.error(TAGS_DEBUG_MESSAGE, "Failed to generate structured tags, falling back to heuristics", {
      id: story.id,
      error,
      model: customEnv.TAGS_MODEL,
    });

    // Fallback to just heuristic tags if structured output fails
    const heur = heuristicTags(story.title, story.url ? new URL(story.url).hostname : undefined);
    const tags = heur.slice(0, customEnv.TAGS_MAX_PER_STORY);

    const payload = {
      id: story.id,
      lang: customEnv.TAGS_LANG,
      tags: tags.map((name) => ({ name })),
      inputHash,
      model: customEnv.TAGS_MODEL,
      createdISO: new Date().toISOString(),
    };

    await writeJsonFile(p, payload, { atomic: true, pretty: true });
    log.info(TAGS_DEBUG_MESSAGE, "fallback tags written", {
      id: story.id,
      count: tags.length,
      model: customEnv.TAGS_MODEL,
    });
  }
}

// Tags-only workflow
async function tagsOnlyWorkflow(services: Services, storyIds: number[], customEnv: Env): Promise<void> {
  for (const id of storyIds) {
    const story = await readJsonSafeOr<NormalizedStory>(
      pathFor.rawItem(id),
      NormalizedStorySchema as unknown as z.ZodType<NormalizedStory>
    );

    if (!story) {
      log.warn(TAGS_DEBUG_MESSAGE, "Missing normalized story file; skipping", { id });
      continue;
    }

    log.info(TAGS_DEBUG_MESSAGE, "Processing story tags", { id });
    try {
      await processTagsOnly(services, story, customEnv);
    } catch (error) {
      log.error(TAGS_DEBUG_MESSAGE, "Unhandled error during tags processing", { id, error: String(error) });
      continue;
    }
  }
}

// Model rotation configuration - using models that support structured outputs
const FALLBACK_MODELS = [
  "mistralai/mistral-small-3.2-24b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-235b-a22b:free",
  "google/gemini-2.0-flash-exp:free",
  "qwen/qwen3-coder:free",
  "deepseek/deepseek-chat-v3-0324:free",
];

const DEFAULT_MODEL = env.TAGS_MODEL;
let currentModelIndex = -1; // -1 means using default model

function getNextModel(): string {
  if (currentModelIndex === -1) {
    // First fallback
    currentModelIndex = 0;
    const model = FALLBACK_MODELS[0];
    if (!model) {
      throw new Error("No fallback models available");
    }
    return model;
  }

  // Cycle through fallback models
  currentModelIndex = (currentModelIndex + 1) % FALLBACK_MODELS.length;
  const model = FALLBACK_MODELS[currentModelIndex];
  if (!model) {
    throw new Error("Invalid fallback model index");
  }
  return model;
}

function getCurrentModel(): string {
  if (currentModelIndex === -1) {
    return DEFAULT_MODEL;
  }
  const model = FALLBACK_MODELS[currentModelIndex];
  if (!model) {
    throw new Error("Invalid current model index");
  }
  return model;
}

async function runTagsWorkflowWithFallback(storyIds: number[]): Promise<void> {
  let completed = false;
  while (!completed) {
    const currentModel = getCurrentModel();
    log.info("tags-bulk", "Attempting with model", { model: currentModel });

    // Create environment with current model
    const customEnv: Env = { ...env, TAGS_MODEL: currentModel };
    const services = makeServices(customEnv);

    try {
      await tagsOnlyWorkflow(services, storyIds, customEnv);
      log.info("tags-bulk", "Successfully completed with model", { model: currentModel });
      completed = true;
    } catch (error) {
      const errorStr = error instanceof Error ? error.message : String(error);

      if (errorStr.includes("429") || errorStr.toLowerCase().includes("rate limit")) {
        log.warn("tags-bulk", "Rate limited, trying next model", {
          currentModel,
          error: errorStr,
        });

        const nextModel = getNextModel();
        log.info("tags-bulk", "Switching to fallback model", {
          from: currentModel,
          to: nextModel,
        });

        continue;
      } else {
        // Non-rate-limit error, propagate it
        throw error;
      }
    }
  }
}

async function getAllStoryIds(): Promise<number[]> {
  try {
    const files = await readdir(PATHS.raw.items);
    const ids = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => Number.parseInt(basename(f, ".json"), 10))
      .filter((id) => !Number.isNaN(id))
      .sort((a, b) => a - b);

    log.info("tags-bulk", "Found story files", { count: ids.length });
    return ids;
  } catch (error) {
    log.error("tags-bulk", "Failed to read story directory", { error });
    return [];
  }
}

async function getStoriesWithoutTags(): Promise<number[]> {
  const allIds = await getAllStoryIds();
  const missingTags: number[] = [];

  for (const id of allIds) {
    const existing = await readJsonSafeOr(pathFor.tagsSummary(id), TagsSummarySchema);
    if (!existing) {
      missingTags.push(id);
    }
  }

  log.info("tags-bulk", "Stories without tags", {
    total: allIds.length,
    missing: missingTags.length,
  });

  return missingTags;
}

async function main(): Promise<void> {
  const { OPENROUTER_API_KEY } = env;
  if (!OPENROUTER_API_KEY) {
    log.error("tags-bulk", "OPENROUTER_API_KEY missing; cannot proceed");
    process.exit(1);
  }

  const storyIds = await getStoriesWithoutTags();

  if (storyIds.length === 0) {
    log.info("tags-bulk", "All stories already have tags!");
    return;
  }

  log.info("tags-bulk", "Starting bulk tag processing", {
    totalStories: storyIds.length,
    defaultModel: DEFAULT_MODEL,
    fallbackModels: FALLBACK_MODELS,
  });

  try {
    await runTagsWorkflowWithFallback(storyIds);
    log.info("tags-bulk", "Bulk tag processing completed successfully");
  } catch (error) {
    log.error("tags-bulk", "Failed to complete bulk processing", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
