export const PATHS = {
  dataDir: "data",
  raw: {
    items: "data/raw/items",
    comments: "data/raw/comments",
    articles: "data/raw/articles",
  },
  summaries: "data/summaries",
  index: "data/index.json",
  aggregated: "data/aggregated.json",
  cache: "data/cache/etag.json",
} as const;

export const pathFor = {
  rawItem: (id: number) => `${PATHS.raw.items}/${id}.json`,
  rawComments: (id: number) => `${PATHS.raw.comments}/${id}.json`,
  articleMd: (id: number) => `${PATHS.raw.articles}/${id}.md`,
  postSummary: (id: number) => `${PATHS.summaries}/${id}.post.json`,
  commentsSummary: (id: number) => `${PATHS.summaries}/${id}.comments.json`,
} as const;
