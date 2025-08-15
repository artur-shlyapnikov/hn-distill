import { z } from "zod";

const IsoString = z.string().regex(/^\d{4}-\d{2}-\d{2}T.*Z$/u, "must be ISO string");

const INVALID_URL_MESSAGE = "Invalid URL";

export const HnItemRawSchema = z.object({
  id: z.number(),
  type: z.enum(["story", "comment"]),
  title: z.string().optional(),
  // accept any string here; validate/normalize later
  url: z.string().optional(),
  text: z.string().optional(),
  by: z.string().optional(),
  time: z.number().int().nonnegative(),
  kids: z.array(z.number()).optional(),
  parent: z.number().optional(),
  score: z.number().optional(),
  descendants: z.number().optional(),
});

export const NormalizedStorySchema = z.object({
  id: z.number(),
  title: z.string().max(500),
  url: z.union([
    z.string().refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, INVALID_URL_MESSAGE),
    z.null(),
  ]),
  by: z.string().max(80),
  timeISO: IsoString,
  commentIds: z.array(z.number()),
  score: z.number().optional(),
  descendants: z.number().optional(),
});

export const NormalizedCommentSchema = z.object({
  id: z.number(),
  by: z.string().max(80),
  timeISO: IsoString,
  textPlain: z.string().max(2000),
  parent: z.number(),
  depth: z.number().int().min(0).max(10),
});

export const IndexSchema = z.object({
  updatedISO: z.string(),
  storyIds: z.array(z.number()),
});

export const LangSchema = z.enum(["en", "ru"]);

export const PostSummarySchema = z.object({
  id: z.number(),
  lang: LangSchema,
  summary: z.string(),
  inputHash: z.string().optional(),
  model: z.string().optional(),
  createdISO: z.string().optional(),
});

export const CommentsSummarySchema = z.object({
  id: z.number(),
  lang: LangSchema,
  summary: z.string(),
  sampleComments: z.array(z.number()).optional(),
  inputHash: z.string().optional(),
  model: z.string().optional(),
  createdISO: z.string().optional(),
});

export const TagSchema = z.object({
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
export const TagsSummarySchema = z.object({
  id: z.number(),
  lang: LangSchema, // keep 'en' regardless of SUMMARY_LANG for canonicalization; see env below
  tags: z.array(TagSchema), // normalized, deduped, max ~12
  inputHash: z.string().optional(),
  model: z.string().optional(),
  createdISO: z.string().optional(),
});

export const AggregatedItemSchema = z.object({
  id: z.number(),
  title: z.string().max(500),
  url: z.union([
    z.string().refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, INVALID_URL_MESSAGE),
    z.null(),
  ]),
  by: z.string().max(80),
  timeISO: IsoString,
  postSummary: z.string().optional(),
  commentsSummary: z.string().optional(),
  score: z.number().optional(),
  commentsCount: z.number().optional(),
  hnUrl: z
    .string()
    .refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "Invalid URL")
    .optional(),
  domain: z.string().optional(),
  tags: z.array(z.string()).optional(), // canonical slugs, e.g. ["llm","python","openai"]
});

export const AggregatedFileSchema = z.object({
  updatedISO: z.string(),
  items: z.array(AggregatedItemSchema),
});

// Inferred types from schemas (single source of truth)
export type HnItemRaw = z.infer<typeof HnItemRawSchema>;
export type NormalizedStory = z.infer<typeof NormalizedStorySchema>;
export type NormalizedComment = z.infer<typeof NormalizedCommentSchema>;
export type PostSummary = z.infer<typeof PostSummarySchema>;
export type CommentsSummary = z.infer<typeof CommentsSummarySchema>;
export type TagsSummary = z.infer<typeof TagsSummarySchema>;
export type AggregatedItem = z.infer<typeof AggregatedItemSchema>;
export type AggregatedFile = z.infer<typeof AggregatedFileSchema>;
