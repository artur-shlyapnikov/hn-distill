
  z.object({
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
      .max(max),
  });

type TagsResponse = z.infer<ReturnType<typeof TagsResponseSchema>>;

const TAGS_DEBUG_MESSAGE = "tags-extract";

export async function summarizeTagsStructured(
  or: OpenRouter,
  prompt: string,
  envLike: Pick<Env, "TAGS_MODEL" | "TAGS_MAX_TOKENS" | "TAGS_MAX_PER_STORY">
): Promise<Array<{ name: string; cat?: string }>> {
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

  // Try structured outputs first
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

    // Fallback to regular chat with JSON instructions
    const jsonResponse = await or.chat(
      [
        {
          role: