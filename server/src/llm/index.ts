import type { ZeverseConfig } from "../config";
import { CloudVerseProvider } from "./cloudverse";
import type { LLMProvider } from "./types";

export type { LLMProvider, LLMMessage, LLMResponse } from "./types";

export function createLLMProvider(config: ZeverseConfig): LLMProvider {
  switch (config.llm.provider) {
    case "custom":
      return new CloudVerseProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.llm.provider}`);
  }
}
