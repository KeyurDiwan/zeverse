import OpenAI from "openai";
import type { ZeverseConfig } from "../config";
import type { LLMMessage, LLMProvider, LLMResponse } from "./types";

export class CloudVerseProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: ZeverseConfig) {
    const baseURL = config.llm.base_url || process.env.CLOUDVERSE_BASE_URL;
    const apiKey = config.llm.api_key || process.env.CLOUDVERSE_API_KEY;

    if (!baseURL || !apiKey) {
      throw new Error(
        "CloudVerse requires CLOUDVERSE_BASE_URL and CLOUDVERSE_API_KEY environment variables"
      );
    }

    this.client = new OpenAI({ baseURL, apiKey });
    this.model = config.llm.model;
    this.maxTokens = config.llm.max_tokens;
    this.temperature = config.llm.temperature;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    let response: any;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
      });
    } catch (err: any) {
      const detail =
        err?.response?.data
          ? JSON.stringify(err.response.data)
          : err?.error
            ? JSON.stringify(err.error)
            : err?.message ?? String(err);
      throw new Error(`CloudVerse request failed (model=${this.model}): ${detail}`);
    }

    if (response?.error) {
      const err = response.error;
      const msg = typeof err === "string" ? err : err.message ?? JSON.stringify(err);
      throw new Error(`CloudVerse returned error (model=${this.model}): ${msg}`);
    }

    if (!response || !Array.isArray(response.choices) || response.choices.length === 0) {
      const preview = JSON.stringify(response ?? null).slice(0, 800);
      throw new Error(
        `CloudVerse returned unexpected response shape (model=${this.model}, no choices[]). ` +
          `Body preview: ${preview}`
      );
    }

    const choice = response.choices[0];
    const content =
      choice?.message?.content ??
      choice?.delta?.content ??
      (typeof choice?.text === "string" ? choice.text : "") ??
      "";

    if (!content) {
      const reason = choice?.finish_reason ?? "unknown";
      const preview = JSON.stringify(choice).slice(0, 800);
      throw new Error(
        `CloudVerse returned empty content (model=${this.model}, finish_reason=${reason}). ` +
          `Choice preview: ${preview}`
      );
    }

    return {
      content,
      model: response.model ?? this.model,
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }
}
