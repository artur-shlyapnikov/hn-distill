import { z } from "zod";

import { log } from "@utils/log";
import { canonicalize, dedupeKeepOrder, heuristicTags } from "@utils/tags";

import type { Env } from "@config/env";
import type { JsonSchema, OpenRouter } from "@utils/openrouter";


const TagInResponseSchema = z.object({
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
});

export const TagsResponseSchema = (max: number): z.ZodObject<{ tags: z.ZodArray<typeof TagInResponseSchema> }> =>
  z.object({
    tags: z.array(TagInResponseSchema).max(max),
  });

type TagsResponse = z.infer<ReturnType<typeof TagsResponseSchema>>;

export function buildTagsPrompt(
  story: { title: string; url: string | null },
  postSummary?: string,
  commentsSummary?: string
): string {
  const { title, url } = story;
  const domain = url ? new URL(url).hostname : "";
  const lines = [
    `Title: ${title}`,
    `URL: ${url ?? "N/A"}`,
    `Domain: ${domain}`,
    postSummary ? `\nArticle summary:\n${postSummary}` : "",
    commentsSummary ? `\nComments summary:\n${commentsSummary}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

const TAGS_DEBUG_MESSAGE = "tags-extract";

export async function summarizeTagsStructured(
  or: OpenRouter,
  prompt: string,
  envLike: Pick<Env, "TAGS_MAX_PER_STORY" | "TAGS_MAX_TOKENS" | "TAGS_MODEL">
): Promise<Array<{ name: string; cat?: string | undefined }>> {
  log.debug(TAGS_DEBUG_MESSAGE, "structured request", {
    model: envLike.TAGS_MODEL,
    promptChars: prompt.length,
  });

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

  const zodSchema = TagsResponseSchema(envLike.TAGS_MAX_PER_STORY);

  try {
    const result = await or.chatStructured<TagsResponse>(
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
- Return at most ${envLike.TAGS_MAX_PER_STORY} tags
- Only return tags that add meaningful categorization value`,
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.5,
        maxTokens: envLike.TAGS_MAX_TOKENS,
        model: envLike.TAGS_MODEL,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "tags_extraction",
            strict: true,
            schema,
          },
        },
      },
      zodSchema,
      2 // reduced retries
    );

    return result.tags.map((tag) => ({
      name: tag.name,
      cat: tag.cat,
    }));
  } catch (error) {
    log.warn(TAGS_DEBUG_MESSAGE, "structured outputs failed, falling back to regular JSON", {
      model: envLike.TAGS_MODEL,
      error: error instanceof Error ? error.message : String(error),
    });

    const jsonResponse = await or.chat(
      [
        {
          role: "system",
          content: `Answer in JSON format: { "tags": [{ "name": "...", "cat": "..." }] }. You are a technical content categorization expert. Extract only the most relevant and certain tags from the given content.

Rules:
- Only include tags you are highly confident about based on explicit mentions or clear context
- Focus on: programming languages, frameworks, databases, cloud platforms, companies, protocols, and core technical concepts
- Use lowercase, normalized names (e.g., "javascript" not "JavaScript", "postgresql" not "PostgreSQL")
- Avoid generic terms like "software", "technology", "development" unless they're the main focus
- Prefer specific over general (e.g., "reactjs" over "frontend")
- Return at most ${envLike.TAGS_MAX_PER_STORY} tags
- Only return tags that add meaningful categorization value`,
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.5,
        maxTokens: envLike.TAGS_MAX_TOKENS,
        model: envLike.TAGS_MODEL,
      }
    );

    try {
      const parsed = JSON.parse(jsonResponse) as unknown;
      const validated = zodSchema.parse(parsed);
      return validated.tags.map((tag) => ({
        name: tag.name,
        cat: tag.cat,
      }));
    } catch (jsonError) {
      log.error(TAGS_DEBUG_MESSAGE, "fallback JSON parsing failed", {
        model: envLike.TAGS_MODEL,
        error: jsonError instanceof Error ? jsonError.message : String(jsonError),
        response: jsonResponse.slice(0, 200),
      });
      throw new Error(`Failed to parse fallback JSON from LLM: ${String(jsonError)}`);
    }
  }
}

export function combineAndCanon(input: {
  llm: Array<{ name: string; cat?: string | undefined }>;
  title: string;
  domain?: string | undefined;
  max: number;
}): string[] {
  const canonLlm = input.llm.map((t) => canonicalize({ name: t.name, cat: t.cat }));
  const heur = heuristicTags(input.title, input.domain).map((slug) => ({ slug }));
  return dedupeKeepOrder([...canonLlm, ...heur]).slice(0, input.max);
}