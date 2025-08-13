import { log } from "./log.js";

import type { HttpClient } from "./http-client.js";

export type ChatMessage = {
  role: "assistant" | "system" | "user";
  content: string;
}

export class OpenRouter {
  private readonly http: HttpClient;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(http: HttpClient, apiKey: string, model: string) {
    this.http = http;
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    type ORResp = {
      choices?: Array<{ message?: { role: string; content?: string } }>;
    }
    log.debug("openrouter", "chat request", {
      model: this.model,
      messages: messages.length,
      hasKey: !!this.apiKey,
    });
    const json = await this.http.json<ORResp>(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/hn-distill",
        "X-Title": "hn-distill",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(options?.temperature === undefined
          ? {}
          : { temperature: options.temperature }),
        ...(options?.maxTokens === undefined
          ? {}
          : { max_tokens: options.maxTokens }),
      }),
      retryOnStatuses: [429],
    });
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content) {
      log.error("openrouter", "Empty content in response");
      throw new Error("OpenRouter: empty content");
    }
    const trimmed = content.trim();
    log.debug("openrouter", "chat response", { contentChars: trimmed.length });
    return trimmed;
  }
}
