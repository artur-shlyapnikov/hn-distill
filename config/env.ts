import { z } from "zod";

const EnvSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),
  SUMMARY_LANG: z.enum(["ru", "en"]).default("ru"),
  TOP_N: z.coerce.number().int().min(1).max(500).default(40),
  MAX_COMMENTS_PER_STORY: z.coerce.number().int().min(1).max(5000).default(40),
  MAX_DEPTH: z.coerce.number().int().min(1).max(10).default(2),
  CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  ARTICLE_SLICE_CHARS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(20000)
    .default(6000),
  MAX_BODY_CHARS: z.coerce.number().int().min(1000).max(50000).default(2000),

  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  HTTP_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  HTTP_BACKOFF_MS: z.coerce.number().int().min(100).max(5000).default(600),

  OPENROUTER_MODEL: z.string().default("openrouter/horizon-beta"),
  OPENROUTER_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(32768)
    .default(8000),

  LOG_LEVEL: z
    .enum(["silent", "error", "warn", "info", "debug"])
    .default("info"),

  SITE: z.string().optional(),
  BASE: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
export type Env = typeof env;
