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

export interface LMStudioTextPart {
  type: "text";
  text: string;
}

export interface LMStudioImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type LMStudioContentPart = LMStudioTextPart | LMStudioImageUrlPart;

export interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    reasoning_content?: string;
    text?: string;
    finish_reason?: string;
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

export interface NativeChatResponse {
  model_instance_id?: string;
  response_id?: string;
  output?: Array<{
    type?: string;
    content?: string;
  }>;
  stats?: {
    input_tokens?: number;
    total_output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: {
    message?: string;
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

export type LMStudioRole = "system" | "user" | "assistant" | "tool";

export interface LMStudioMessage {
  role: LMStudioRole;
  content: string | LMStudioContentPart[];
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface ChatImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
}

export interface ChatContextBlock {
  id: string;
  source: "selection" | "activeFile" | "file" | "codebase";
  label: string;
  content: string;
  filePath?: string;
  languageId?: string;
  lineStart?: number;
  lineEnd?: number;
  truncated?: boolean;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  attachments?: ChatImageAttachment[];
  contextBlocks?: ChatContextBlock[];
  thinking?: string;
  generationTimeMs?: number;
  renderedContent?: string;
  renderedThinking?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  name?: string;
  toolSummary?: string;
  tool_call_id?: string;
  toolMeta?: {
    command?: string;
    cwd?: string;
    timeoutMs?: number;
    terminalId?: string;
  };
  resolvedPath?: string;
  fileEdit?: {
    filePath: string;
    oldContent: string | null;
    newContent: string;
    additions?: number;
    deletions?: number;
    applied?: boolean;
    discarded?: boolean;
    superseded?: boolean;
    diffs?: Array<{ added?: boolean; removed?: boolean; value: string; count?: number }>;
  };
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
