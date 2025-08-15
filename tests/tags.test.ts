import { describe, expect, test, mock } from "bun:test";

import { env } from "@config/env";
import { buildTagsPrompt, combineAndCanon, summarizeTagsStructured } from "@utils/tags-extract";
import { canonicalize, slugify, heuristicTags } from "@utils/tags";

import type { OpenRouter } from "@utils/openrouter";
import type { NormalizedStory } from "@config/schemas";

describe("Tags extraction & canonicalization", () => {
  test("15. buildTagsPrompt includes domain and summaries when provided", () => {
    const story: Pick<NormalizedStory, "title" | "url"> = {
      title: "Test Story",
      url: "https://sub.example.com/x",
    };
    const postSummary = "This is the post summary.";
    const commentsSummary = "This is the comments summary.";

    const prompt = buildTagsPrompt(story, postSummary, commentsSummary);

    expect(prompt).toContain(`URL: ${story.url}`);
    expect(prompt).toContain("Domain: sub.example.com");
    expect(prompt).toContain(postSummary);
    expect(prompt).toContain(commentsSummary);
  });

  test("16. combineAndCanon merges LLM + heuristics, dedupes, keeps order", () => {
    const llm = [{ name: "react" }, { name: "Open AI" }, { name: "postgres" }];
    const title = "A story about OpenAI, ReactJS, and PostgreSQL";
    const domain = "github.com"; // for "github" heuristic tag

    // Heuristics from title/domain will be: ["github", "reactjs", "postgresql", "openai"] (order may vary but set is same)
    // Canonicalized LLM tags will be: reactjs, openai, postgresql
    const result = combineAndCanon({ llm, title, domain, max: 10 });

    // Order of first appearance: react (from LLM), Open AI (from LLM), postgres (from LLM), github (from heuristics)
    expect(result).toEqual(["reactjs", "openai", "postgresql", "github"]);
  });

  test("17. slugify handles symbols and case consistently", () => {
    expect(slugify("C++/CLI & .NET")).toBe("c++-cli-.net");
    expect(slugify("  Web Assembly  ")).toBe("web-assembly");
    expect(slugify("don’t-test—me")).toBe("dont-test-me");
  });

  test("18. canonicalize applies aliases", () => {
    expect(canonicalize({ name: "JS" }).slug).toBe("javascript");
    expect(canonicalize({ name: "react" }).slug).toBe("reactjs");
    expect(canonicalize({ name: "psql" }).slug).toBe("postgresql");
  });

  test("19. heuristicTags domain detection and cap", () => {
    const domain = "github.com";
    const title = "Rust, Python, React, Docker, K8s, GraphQL, Redis, Postgres, Tailwind, Go, Swift, Kotlin, Elixir";
    const tags = heuristicTags(title, domain);

    expect(tags).toContain("github");
    expect(tags).toContain("rust");
    expect(tags).toContain("python");
    expect(tags).toContain("reactjs");
    expect(tags.length).toBeLessThanOrEqual(12);
  });

  test("20. summarizeTagsStructured falls back to JSON-mode and validates (negative)", async () => {
    const mockOr = {
      chatStructured: mock(async () => {
        throw new Error("Structured call failed");
      }),
      chat: mock(async () =>
        JSON.stringify({
          tags: [
            { name: "python", cat: "lang" },
            { name: "openai", cat: "company" },
          ],
        })
      ),
    } as unknown as OpenRouter;

    const result = await summarizeTagsStructured(mockOr, "prompt", env);

    expect(result).toEqual([
      { name: "python", cat: "lang" },
      { name: "openai", cat: "company" },
    ]);
    expect(mockOr.chatStructured).toHaveBeenCalledTimes(1);
    expect(mockOr.chat).toHaveBeenCalledTimes(1);
  });

  test("21. summarizeTagsStructured hard-bad JSON → error surfaced (negative)", async () => {
    const mockOr = {
      chatStructured: mock(async () => {
        throw new Error("Structured call failed");
      }),
      chat: mock(async () => "not json"),
    } as unknown as OpenRouter;

    await expect(summarizeTagsStructured(mockOr, "prompt", env)).rejects.toThrow(
      "Failed to parse fallback JSON from LLM"
    );
  });
});