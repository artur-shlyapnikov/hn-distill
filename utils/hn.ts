export const HN = {
  api: "https://hacker-news.firebaseio.com/v0",
  itemUrl: (id: number) => `https://news.ycombinator.com/item?id=${id}`,
} as const;
