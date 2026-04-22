import OpenAI from "openai";
import type { ArchonConfig } from "../config";
import type { LLMMessage, LLMProvider, LLMResponse } from "./types";

export class CloudVerseProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: ArchonConfig) {
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
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    const choice = response.choices[0];
    return {
      content: choice?.message?.content ?? "",
      model: response.model,
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
