export interface LSPilotSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  chatTimeoutMs: number;
  modelLoadTimeoutMs: number;
  minRequestGapMs: number;
  maxLines: number;
  chatMaxTokens: number;
  systemPrompt: string;
  chatSystemPrompt: string;
}

export interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
    };
    reasoning_content?: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

export interface NativeModelEntry {
  key?: string;
  size_bytes?: number;
  loaded_instances?: Array<{ id?: string }>;
}

export interface NativeModelsResponse {
  models?: NativeModelEntry[];
}

export type LMStudioRole = "system" | "user" | "assistant";

export interface LMStudioMessage {
  role: LMStudioRole;
  content: string;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
}

export interface ChatContextUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindowTokens: number;
  usageRatio: number;
  usagePercent: number;
  details: string;
}

export interface ChatTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
