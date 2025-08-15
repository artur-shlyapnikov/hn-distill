import { log } from "@utils/log";

import type { HttpClient } from "./http-client";
import type { z } from "zod";

export type ChatMessage = {
  role: "assistant" | "system" | "user";
  content: string;
};

export type JsonSchema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
};

export type StructuredOutputOptions = {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  responseFormat?: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: boolean;
      schema: JsonSchema;
    };
  };
};

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
    options?: { temperature?: number; maxTokens?: number; model?: string }
  ): Promise<string> {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    type ORResp = {
      choices?: Array<{ message?: { role: string; content?: string } }>;
    };
    log.debug("openrouter", "chat request", {
      model: options?.model ?? this.model,
      messages: messages.length,
      hasKey: !!this.apiKey,
    });
    const json: ORResp = await this.http.json<ORResp>(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/hn-distill",
        "X-Title": "hn-distill",
      },
      body: JSON.stringify({
        model: options?.model ?? this.model,
        messages,
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options?.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
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

  private buildStructuredRequestBody(messages: ChatMessage[], options: StructuredOutputOptions): string {
    return JSON.stringify({
      model: options.model ?? this.model,
      messages,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    });
  }

  private async makeStructuredRequest<T>(
    url: string,
    requestBody: string,
    zodSchema: z.ZodSchema<T>,
    attempt: number
  ): Promise<T> {
    type ORResp = {
      choices?: Array<{ message?: { role: string; content?: string } }>;
    };

    const json: ORResp = await this.http.json<ORResp>(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/hn-distill",
        "X-Title": "hn-distill",
      },
      body: requestBody,
      retryOnStatuses: [429],
    });

    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content) {
      throw new Error("Empty content in structured response");
    }

    const trimmed = content.trim();
    const parsed = JSON.parse(trimmed) as unknown;
    const validated = zodSchema.parse(parsed);

    log.debug("openrouter", "structured response parsed", {
      contentChars: trimmed.length,
      attempt,
    });
    return validated;
  }

  async chatStructured<T>(
    messages: ChatMessage[],
    options: StructuredOutputOptions,
    zodSchema: z.ZodSchema<T>,
    maxRetries = 3
  ): Promise<T> {
    const url = "https://openrouter.ai/api/v1/chat/completions";
    const requestBody = this.buildStructuredRequestBody(messages, options);

    log.debug("openrouter", "structured chat request", {
      model: options.model ?? this.model,
      messages: messages.length,
      hasKey: !!this.apiKey,
      schema: options.responseFormat?.json_schema.name,
      maxRetries,
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.makeStructuredRequest(url, requestBody, zodSchema, attempt);
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        log.warn("openrouter", `Structured parsing failed (attempt ${attempt}/${maxRetries})`, {
          error: error instanceof Error ? error.message : String(error),
          isLastAttempt,
        });

        if (isLastAttempt) {
          log.error("openrouter", "All structured parsing attempts failed", { error });
          throw new Error(
            `OpenRouter structured output failed after ${maxRetries} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }

        await new Promise<void>((resolve: (value: PromiseLike<void> | void) => void) =>
          setTimeout(resolve, 200 * attempt)
        );
      }
    }

    throw new Error("Unexpected end of retry loop");
  }
}
