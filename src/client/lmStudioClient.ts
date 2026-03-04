import * as vscode from "vscode";
import type {
  ChatTokenUsage,
  ChatCompletionResponse,
  ChatHistoryMessage,
  LMStudioMessage,
  LSPilotSettings,
  ModelsResponse,
  NativeChatResponse,
  NativeModelEntry,
  NativeModelsResponse
} from "../types";

function isLikelyEmbeddingModelId(modelId: string): boolean {
  return (
    /^text-embedding/i.test(modelId) ||
    /(?:^|[-_])embedding(?:$|[-_])/i.test(modelId) ||
    /(?:^|[-_])embed(?:$|[-_])/i.test(modelId) ||
    /nomic-embed/i.test(modelId)
  );
}

function filterGenerationModelIds(modelIds: string[]): string[] {
  return modelIds.filter((id) => !isLikelyEmbeddingModelId(id));
}

function dedupeLikelyInstanceAliases(modelIds: string[]): string[] {
  const uniqueInOrder: string[] = [];
  const seen = new Set<string>();
  for (const id of modelIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    uniqueInOrder.push(id);
  }

  const fullSet = new Set(uniqueInOrder);
  return uniqueInOrder.filter((id) => {
    const match = id.match(/^(.*)-(\d+)$/);
    if (!match) {
      return true;
    }
    const baseId = match[1];
    // If a canonical base id exists, drop the numeric-suffixed alias from picker.
    return !fullSet.has(baseId);
  });
}

function isNumericSuffixAliasOf(candidate: string, baseModel: string): boolean {
  const match = candidate.match(/^(.*)-(\d+)$/);
  return !!match && match[1] === baseModel;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const errorRecord = error as { code?: unknown; cause?: unknown };
  if (typeof errorRecord.code === "string") {
    return errorRecord.code;
  }

  if (errorRecord.cause && typeof errorRecord.cause === "object") {
    const causeRecord = errorRecord.cause as { code?: unknown };
    if (typeof causeRecord.code === "string") {
      return causeRecord.code;
    }
  }

  return undefined;
}

function formatLMStudioRequestError(
  error: unknown,
  settings: LSPilotSettings,
  endpoint: "/models" | "/chat/completions" | "/completions" | "/api/v1/chat" | "/api/v1/models/load" | "/api/v1/models/unload",
  timeoutSettingKey?: "lspilot.timeoutMs" | "lspilot.chatTimeoutMs" | "lspilot.modelLoadTimeoutMs"
): string {
  const targetUrl = `${settings.baseUrl}${endpoint}`;
  const defaultMessage = error instanceof Error ? error.message : String(error);
  const code = getErrorCode(error);
  const timeoutKey =
    timeoutSettingKey ?? (endpoint === "/api/v1/models/load" ? "lspilot.modelLoadTimeoutMs" : "lspilot.timeoutMs");

  if (code === "ECONNREFUSED") {
    return `Cannot connect to LM Studio at ${targetUrl}. Start LM Studio local server and verify lspilot.baseUrl.`;
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `LM Studio host is unreachable at ${targetUrl}. Verify lspilot.baseUrl.`;
  }

  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `Connection to LM Studio timed out at ${targetUrl}. Ensure server is running and increase ${timeoutKey} if needed.`;
  }

  if (defaultMessage === "fetch failed") {
    return `Request to LM Studio failed at ${targetUrl}. Ensure LM Studio is running, local server is enabled, and lspilot.baseUrl is correct.`;
  }

  if (defaultMessage === "This operation was aborted") {
    return `Request to LM Studio timed out or was cancelled at ${targetUrl}. Consider increasing ${timeoutKey}.`;
  }

  return defaultMessage;
}

function isMissingInstanceIdMessage(message: string): boolean {
  return /missing required field ['"]instance_id['"]/i.test(message);
}

function extractCompletionText(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  if (!choice) {
    return "";
  }

  const messageContent = choice.message?.content;
  if (typeof messageContent === "string") {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }

  return choice.text ?? "";
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === "object")
      .map((part) => part as { type?: string; text?: string })
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }

  return "";
}

function parseThinkTaggedText(rawText: string): { text: string; reasoning?: string } {
  let text = "";
  let reasoning = "";
  let inThinking = false;

  for (let i = 0; i < rawText.length; ) {
    if (rawText.startsWith("<think>", i)) {
      inThinking = true;
      i += "<think>".length;
      continue;
    }

    if (rawText.startsWith("</think>", i)) {
      inThinking = false;
      i += "</think>".length;
      continue;
    }

    const char = rawText[i];
    if (inThinking) {
      reasoning += char;
    } else {
      text += char;
    }
    i += 1;
  }

  const cleanedReasoning = reasoning.trim();
  return {
    text: text.trim(),
    reasoning: cleanedReasoning.length > 0 ? cleanedReasoning : undefined
  };
}

function mergeDisplayedResponse(rawText: string, explicitReasoning: string): { text: string; reasoning?: string } {
  const fromThinkTags = parseThinkTaggedText(rawText);
  const cleanedExplicit = explicitReasoning.trim();

  if (cleanedExplicit.length > 0) {
    return {
      text: fromThinkTags.text,
      reasoning: cleanedExplicit
    };
  }

  return fromThinkTags;
}

function extractReasoningAndResponse(response: ChatCompletionResponse): { text: string; reasoning?: string; tool_calls?: any[] } {
  const choice = response.choices?.[0];
  if (!choice) {
    return { text: "" };
  }

  const rawText = extractCompletionText(response);
  const messageReasoning = extractTextFromMessageContent(choice.message?.reasoning_content);
  const choiceReasoning = typeof choice.reasoning_content === "string" ? choice.reasoning_content : "";
  const explicitReasoning = messageReasoning || choiceReasoning;
  return { ...mergeDisplayedResponse(rawText, explicitReasoning), tool_calls: choice.message?.tool_calls };
}

function extractTokenUsage(response: ChatCompletionResponse): ChatTokenUsage | undefined {
  const usage = response.usage;
  if (!usage) {
    return undefined;
  }

  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;

  if (typeof totalTokens !== "number" && typeof promptTokens !== "number" && typeof completionTokens !== "number") {
    return undefined;
  }

  const safePrompt = Math.max(0, promptTokens ?? 0);
  const safeCompletion = Math.max(0, completionTokens ?? 0);
  const safeTotal = Math.max(0, totalTokens ?? safePrompt + safeCompletion);

  return {
    promptTokens: safePrompt,
    completionTokens: safeCompletion,
    totalTokens: safeTotal
  };
}

function extractNativeChatOutput(response: NativeChatResponse): { text: string; reasoning?: string } {
  const output = Array.isArray(response.output) ? response.output : [];
  let text = "";
  let reasoning = "";

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const type = typeof item.type === "string" ? item.type : "";
    const content = typeof item.content === "string" ? item.content : "";
    if (!content) {
      continue;
    }

    if (type === "reasoning") {
      reasoning += content;
      continue;
    }

    if (type === "message") {
      text += content;
    }
  }

  return {
    text: text.trim(),
    reasoning: reasoning.trim() || undefined
  };
}

function extractNativeUsage(response: NativeChatResponse): ChatTokenUsage | undefined {
  const stats = response.stats;
  if (!stats) {
    return undefined;
  }

  const promptTokens = typeof stats.input_tokens === "number" ? Math.max(0, stats.input_tokens) : 0;
  const completionTokens = typeof stats.total_output_tokens === "number" ? Math.max(0, stats.total_output_tokens) : 0;
  const totalTokens = Math.max(0, promptTokens + completionTokens);

  if (promptTokens === 0 && completionTokens === 0) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

function extractDeltaText(delta: unknown): { content: string; reasoning: string; tool_calls?: any[] } {
  if (!delta || typeof delta !== "object") {
    return { content: "", reasoning: "" };
  }

  const record = delta as Record<string, unknown>;
  const content = extractTextFromMessageContent(record.content);
  const reasoningContent = extractTextFromMessageContent(record.reasoning_content);
  const reasoning = reasoningContent || extractTextFromMessageContent(record.reasoning);

  return { content, reasoning, tool_calls: record.tool_calls as any[] | undefined };
}

async function* readSseEventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        buffer = buffer.replace(/\r\n/g, "\n");
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const eventBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        const lines = eventBlock.split(/\r?\n/);
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (dataLines.length > 0) {
          yield dataLines.join("\n");
        }
      }
    }

    const tail = buffer.trim();
    if (tail.length > 0) {
      const lines = tail.split(/\r?\n/);
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length > 0) {
        yield dataLines.join("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function cleanCompletion(raw: string, suffix: string, maxLines: number): string {
  let text = raw.replace(/\r\n/g, "\n");

  // Remove common markdown wrappings that chat models sometimes leak
  text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, "");
  text = text.replace(/\n?```$/, "");
  
  // Remove FIM tags if the model leaks them
  text = text.replace(/<\|?fim_middle\|?>/g, "");
  text = text.replace(/<\|?fim_suffix\|?>/g, "");

  if (suffix && text.startsWith(suffix)) {
    text = text.slice(suffix.length);
  }

  // Allow ghost text that is purely whitespace if it provides indentation
  if (text.length === 0) {
    return "";
  }

  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
  }

  return text;
}

function extractPositiveNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractRuntimeContextWindowFromRecord(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const directKeys = [
    "loaded_context_length",
    "runtime_context_length",
    "n_ctx",
    "ctx_size",
    "context_length"          // Found inside loaded_instances[].config
  ];
  for (const key of directKeys) {
    const value = extractPositiveNumber(record, key);
    if (value) {
      return Math.round(value);
    }
  }

  const nestedKeys = ["metadata", "model_info", "info", "config"];
  for (const nestedKey of nestedKeys) {
    const nested = record[nestedKey];
    if (nested && typeof nested === "object") {
      const value = extractRuntimeContextWindowFromRecord(nested);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function isNativeModelEntryLoading(entry: NativeModelEntry): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const record = entry as unknown as Record<string, unknown>;
  const directBooleanKeys = ["loading", "is_loading", "isLoading"];
  for (const key of directBooleanKeys) {
    if (record[key] === true) {
      return true;
    }
  }

  const stateValue = record.state;
  if (typeof stateValue === "string" && /(loading|initializing|warming|pending)/i.test(stateValue)) {
    return true;
  }

  if (stateValue && typeof stateValue === "object") {
    const stateRecord = stateValue as Record<string, unknown>;
    if (stateRecord.loading === true || stateRecord.isLoading === true || stateRecord.is_loading === true) {
      return true;
    }
    if (typeof stateRecord.status === "string" && /(loading|initializing|warming|pending)/i.test(stateRecord.status)) {
      return true;
    }
  }

  const progressValue = record.progress;
  if (progressValue && typeof progressValue === "object") {
    const progressRecord = progressValue as Record<string, unknown>;
    if (progressRecord.loading === true || progressRecord.active === true || progressRecord.in_progress === true) {
      return true;
    }
  }

  return false;
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "on", "enabled", "enable", "supported"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "off", "disabled", "disable", "unsupported", "none"].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

function extractReasoningSupportFromRecord(raw: unknown, seen = new WeakSet<object>()): boolean | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const rawObject = raw as object;
  if (seen.has(rawObject)) {
    return undefined;
  }
  seen.add(rawObject);

  const record = raw as Record<string, unknown>;

  const directKeys = [
    "supports_reasoning",
    "supportsReasoning",
    "reasoning_supported",
    "reasoningEnabled",
    "supports_thinking",
    "supportsThinking",
    "thinking_supported",
    "enable_thinking",
    "enableThinking",
    "deep_thinking",
    "deepThinking"
  ];
  for (const key of directKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const parsed = parseBooleanLike(record[key]);
    if (typeof parsed === "boolean") {
      return parsed;
    }
  }

  const capabilities = record.capabilities;
  if (capabilities && typeof capabilities === "object") {
    const capabilityRecord = capabilities as Record<string, unknown>;
    for (const key of ["reasoning", "thinking", "deep_thinking", "supports_reasoning", "supports_thinking"]) {
      if (!Object.prototype.hasOwnProperty.call(capabilityRecord, key)) {
        continue;
      }
      const parsed = parseBooleanLike(capabilityRecord[key]);
      if (typeof parsed === "boolean") {
        return parsed;
      }
    }
  }

  const customFieldContainers = ["custom_fields", "customFields", "inference_params", "inferenceParameters", "parameters"];
  for (const key of customFieldContainers) {
    const container = record[key];
    if (!Array.isArray(container)) {
      continue;
    }

    for (const entry of container) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const entryRecord = entry as Record<string, unknown>;
      const labelKeys = ["key", "name", "id", "slug", "field", "label"];
      const label = labelKeys
        .map((labelKey) => entryRecord[labelKey])
        .find((value): value is string => typeof value === "string");
      if (!label || !/thinking|reasoning/i.test(label)) {
        continue;
      }

      for (const valueKey of ["value", "default", "enabled", "supported"]) {
        const parsed = parseBooleanLike(entryRecord[valueKey]);
        if (typeof parsed === "boolean") {
          return parsed;
        }
      }

      // Presence of an explicit thinking-related field usually means the model supports toggling it.
      return true;
    }
  }

  for (const value of Object.values(record)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const nested = extractReasoningSupportFromRecord(value, seen);
    if (typeof nested === "boolean") {
      return nested;
    }
  }

  return undefined;
}

function isExplicitNoThinkingSupportMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /model does not support the reasoning setting/i.test(message) ||
    (/reasoning/.test(normalized) && /does not support|unsupported|not supported/.test(normalized)) ||
    (/thinking/.test(normalized) && /does not support|unsupported|not supported/.test(normalized))
  );
}

function isThinkingParameterRejectedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  if (isExplicitNoThinkingSupportMessage(message)) {
    return true;
  }

  return (
    (/enable_thinking|reasoning|reasoning_effort|extra fields|extra inputs|unknown field|unrecognized field/.test(normalized) &&
      /unknown|unrecognized|invalid|unsupported|not supported|extra fields|extra inputs/.test(normalized)) ||
    /enable_thinking.*(not allowed|forbidden|unexpected)/.test(normalized)
  );
}

class ModelUnloadUnsupportedError extends Error {
  public constructor(message = "LM Studio does not expose a model unload endpoint, so exclusive single-model loading cannot be enforced.") {
    super(message);
    this.name = "ModelUnloadUnsupportedError";
  }
}

export class LMStudioClient {
  private cachedModel: string | undefined;
  private modelCacheTimestamp = 0;
  private readonly modelCacheTtlMs = 60_000;
  private modelLoadPromises = new Map<string, Promise<void>>();
  private modelMutationQueue: Promise<void> = Promise.resolve();
  private activeModelKey: string | undefined;
  private activeModelMarkedAt = 0;
  private readonly activeModelGracePeriodMs = 30_000;
  private thinkingSupportCache = new Map<string, boolean>();
  private thinkingSupportProbePromises = new Map<string, Promise<boolean>>();
  private reasoningOffResponseIdByModel = new Map<string, string>();

  public getSettings(): LSPilotSettings {
    const config = vscode.workspace.getConfiguration("lspilot");
    return {
      enabled: config.get<boolean>("enabled", true),
      baseUrl: config.get<string>("baseUrl", "http://127.0.0.1:1234/v1").replace(/\/+$/, ""),
      model: config.get<string>("model", "").trim(),
      temperature: config.get<number>("temperature", 0.2),
      maxTokens: config.get<number>("maxTokens", 96),
      timeoutMs: config.get<number>("timeoutMs", 15000),
      chatTimeoutMs: config.get<number>("chatTimeoutMs", 60000),
      modelLoadTimeoutMs: config.get<number>("modelLoadTimeoutMs", 180000),
      minRequestGapMs: config.get<number>("minRequestGapMs", 300),
      maxLines: config.get<number>("maxLines", 8),
      chatMaxTokens: config.get<number>("chatMaxTokens", 512),
      systemPrompt: config.get<string>(
        "systemPrompt",
        "You are a coding assistant that returns only the next code continuation. Do not explain. Do not wrap output in markdown fences."
      ),
      chatSystemPrompt: config.get<string>(
        "chatSystemPrompt",
        "You are a helpful coding assistant inside VS Code. Give direct, practical answers with runnable code when useful."
      )
    };
  }

  public invalidateModelCache(): void {
    this.cachedModel = undefined;
    this.modelCacheTimestamp = 0;
    this.thinkingSupportCache.clear();
    this.thinkingSupportProbePromises.clear();
    this.reasoningOffResponseIdByModel.clear();
  }

  public clearThinkingSupportCache(model?: string): void {
    if (!model) {
      this.thinkingSupportCache.clear();
      this.thinkingSupportProbePromises.clear();
      return;
    }

    this.thinkingSupportCache.delete(model);
    this.thinkingSupportProbePromises.delete(model);
  }

  public resetReasoningOffSession(model?: string): void {
    if (!model) {
      this.reasoningOffResponseIdByModel.clear();
      return;
    }

    const normalized = model.trim();
    if (!normalized) {
      return;
    }
    this.reasoningOffResponseIdByModel.delete(normalized);
  }

  public async listModels(token: vscode.CancellationToken): Promise<string[]> {
    const settings = this.getSettings();
    try {
      const nativeModels = await this.fetchNativeModels(settings, token);
      const nativeIds = nativeModels
        .map((entry) => (typeof entry.key === "string" ? entry.key.trim() : ""))
        .filter((id): id is string => id.length > 0);
      const filteredNativeIds = filterGenerationModelIds(nativeIds);
      return dedupeLikelyInstanceAliases(filteredNativeIds);
    } catch {
      const models = await this.fetchModels(settings, token);
      const ids = models
        .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
        .filter((id): id is string => id.length > 0);
      return dedupeLikelyInstanceAliases(filterGenerationModelIds(ids));
    }
  }

  public async testConnection(token: vscode.CancellationToken): Promise<{ model: string; sample: string }> {
    const settings = this.getSettings();
    const model = await this.resolveModel(settings);
    await this.loadModel(model, token);
    const completion = await this.chatCompletion(
      {
        model,
        messages: [
          { role: "system", content: settings.systemPrompt },
          { role: "user", content: "Return exactly: ok" }
        ],
        temperature: 0,
        max_tokens: 8,
        stream: false
      },
      settings,
      token
    );

    return { model, sample: completion.text.trim() };
  }

  public async loadModel(model: string, token: vscode.CancellationToken): Promise<void> {
    const targetModel = model.trim();
    if (!targetModel) {
      throw new Error("Model ID is required.");
    }

    const existing = this.modelLoadPromises.get(targetModel);
    if (existing) {
      return existing;
    }

    const promise = this.enqueueModelMutation(async () => {
      if (token.isCancellationRequested) {
        throw new Error("This operation was aborted");
      }
      await this.doLoadModel(targetModel, token);
    }).finally(() => {
      if (this.modelLoadPromises.get(targetModel) === promise) {
        this.modelLoadPromises.delete(targetModel);
      }
    });
    this.modelLoadPromises.set(targetModel, promise);
    return promise;
  }

  private enqueueModelMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.modelMutationQueue.then(operation, operation);
    this.modelMutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async doLoadModel(model: string, token: vscode.CancellationToken): Promise<void> {
    const settings = this.getSettings();
    const nativeApiBase = this.getNativeApiBase(settings.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.modelLoadTimeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      await this.unloadOtherLoadedModels(model, settings, token);

      if (
        this.activeModelKey === model &&
        Date.now() - this.activeModelMarkedAt < this.activeModelGracePeriodMs
      ) {
        return;
      }

      const alreadyLoaded = await this.isModelLoaded(model, token);
      if (alreadyLoaded) {
        this.activeModelKey = model;
        this.activeModelMarkedAt = Date.now();
        return;
      }

      try {
        const response = await fetch(`${nativeApiBase}/api/v1/models/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
          signal: controller.signal
        });

        if (!response.ok) {
          if (response.status === 404 || response.status === 405) {
            await this.warmupModelWithChatCompletion(model, settings, token);
            await this.unloadOtherLoadedModels(model, settings, token);
            this.activeModelKey = model;
            this.activeModelMarkedAt = Date.now();
            return;
          }

          let details = "";
          try {
            const body = (await response.json()) as { error?: { message?: string } | string; message?: string };
            if (typeof body.error === "string") {
              details = body.error;
            } else if (body.error && typeof body.error.message === "string") {
              details = body.error.message;
            } else if (typeof body.message === "string") {
              details = body.message;
            }
          } catch {
            // Ignore JSON parse errors and surface HTTP status below.
          }

          throw new Error(details || `LM Studio model load failed (${response.status})`);
        }
      } catch (error) {
        const code = getErrorCode(error);
        if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ETIMEDOUT") {
          throw new Error(formatLMStudioRequestError(error, settings, "/api/v1/models/load"));
        }

        if (error instanceof Error && error.message === "This operation was aborted") {
          throw new Error(formatLMStudioRequestError(error, settings, "/api/v1/models/load"));
        }

        if (error instanceof Error && error.message === "fetch failed") {
          await this.warmupModelWithChatCompletion(model, settings, token);
          await this.unloadOtherLoadedModels(model, settings, token);
          this.activeModelKey = model;
          this.activeModelMarkedAt = Date.now();
          return;
        }

        throw error;
      }
      await this.unloadOtherLoadedModels(model, settings, token);
      this.activeModelKey = model;
      this.activeModelMarkedAt = Date.now();
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async listConflictingLoadedOrLoadingModels(
    modelToKeep: string,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<string[]> {
    let nativeModels: NativeModelEntry[] = [];
    try {
      nativeModels = await this.fetchNativeModels(settings, token);
    } catch {
      // If model status endpoint is unavailable, we cannot inspect conflicts.
      return [];
    }

    const normalizedKeep = modelToKeep.trim();
    const targets = new Set<string>();
    for (const entry of nativeModels) {
      const modelKey = typeof entry.key === "string" ? entry.key.trim() : "";
      const instances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : [];
      const instanceIds = instances
        .map((instance) => (typeof instance?.id === "string" ? instance.id.trim() : ""))
        .filter((id): id is string => id.length > 0);
      const isLoading = isNativeModelEntryLoading(entry);

      const isTargetModelEntry = modelKey === normalizedKeep;
      const hasTargetInstance = instanceIds.includes(normalizedKeep);
      const targetInstanceToKeep = hasTargetInstance ? normalizedKeep : isTargetModelEntry ? instanceIds[0] : undefined;

      if (isTargetModelEntry || hasTargetInstance) {
        for (const instanceId of instanceIds) {
          if (targetInstanceToKeep && instanceId === targetInstanceToKeep) {
            continue;
          }
          targets.add(instanceId);
        }
        continue;
      }

      for (const instanceId of instanceIds) {
        if (instanceId !== normalizedKeep) {
          targets.add(instanceId);
        }
      }

      if (isLoading && modelKey && modelKey !== normalizedKeep) {
        targets.add(modelKey);
      }
    }

    return Array.from(targets);
  }

  private async unloadOtherLoadedModels(
    modelToKeep: string,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<void> {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const targets = await this.listConflictingLoadedOrLoadingModels(modelToKeep, settings, token);
      if (targets.length === 0) {
        return;
      }

      for (const unloadTarget of targets) {
        const outcome = await this.doUnloadModel(unloadTarget, settings, token);
        if (outcome === "unsupported") {
          throw new ModelUnloadUnsupportedError();
        }
      }

      if (attempt < maxAttempts - 1) {
        await new Promise<void>((resolve, reject) => {
          let cancelListener: vscode.Disposable | undefined;
          const timeout = setTimeout(() => {
            cancelListener?.dispose();
            resolve();
          }, 300);
          cancelListener = token.onCancellationRequested(() => {
            clearTimeout(timeout);
            cancelListener?.dispose();
            reject(new Error("This operation was aborted"));
          });
        });
      }
    }

    const remaining = await this.listConflictingLoadedOrLoadingModels(modelToKeep, settings, token);
    if (remaining.length > 0) {
      throw new Error(`Unable to unload conflicting LM Studio models before loading "${modelToKeep}": ${remaining.join(", ")}`);
    }
  }

  public async unloadModel(model: string, token: vscode.CancellationToken): Promise<void> {
    const targetModel = model.trim();
    if (!targetModel) {
      return;
    }

    await this.enqueueModelMutation(async () => {
      if (token.isCancellationRequested) {
        throw new Error("This operation was aborted");
      }
      const settings = this.getSettings();
      const outcome = await this.doUnloadModel(targetModel, settings, token);
      if (outcome === "unsupported") {
        throw new ModelUnloadUnsupportedError();
      }
    });
  }

  private async doUnloadModel(
    model: string,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<"ok" | "unsupported"> {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return "ok";
    }

    const nativeModels = await this.fetchNativeModels(settings, token).catch(() => [] as NativeModelEntry[]);
    const matchingEntries = nativeModels.filter((entry) => {
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (!key) {
        return false;
      }
      return key === normalizedModel || isNumericSuffixAliasOf(key, normalizedModel);
    });

    const instanceIds = matchingEntries
      .flatMap((entry) => (entry.loaded_instances ?? []))
      .map((instance) => (typeof instance?.id === "string" ? instance.id.trim() : ""))
      .filter((id): id is string => id.length > 0);

    const modelKeys = new Set<string>([normalizedModel]);
    for (const entry of matchingEntries) {
      const key = typeof entry.key === "string" ? entry.key.trim() : "";
      if (key.length > 0) {
        modelKeys.add(key);
      }
    }

    const unloadTargets: Array<Record<string, string>> = [];
    const seenTargets = new Set<string>();
    const pushUnloadTarget = (target: Record<string, string>): void => {
      const key = JSON.stringify(target);
      if (seenTargets.has(key)) {
        return;
      }
      seenTargets.add(key);
      unloadTargets.push(target);
    };

    for (const instanceId of instanceIds) {
      pushUnloadTarget({ instance_id: instanceId });
    }
    for (const modelKey of modelKeys) {
      pushUnloadTarget({ model: modelKey });
    }

    let unloaded = false;
    let sawMissingInstanceId = false;
    let lastError: Error | undefined;

    for (const target of unloadTargets) {
      try {
        const result = await this.requestModelUnload(target, settings, token);
        if (result === "unsupported") {
          return "unsupported";
        }
        unloaded = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isMissingInstanceIdMessage(message)) {
          sawMissingInstanceId = true;
          continue;
        }
        lastError = error instanceof Error ? error : new Error(message);
      }
    }

    if (!unloaded && lastError) {
      throw lastError;
    }

    // Some API variants reject { model } and require only { instance_id }.
    // If we saw that error and had no known instance, keep shutdown best-effort.
    if (!unloaded && sawMissingInstanceId) {
      return "ok";
    }

    if (this.activeModelKey && this.activeModelKey === normalizedModel) {
      this.activeModelKey = undefined;
      this.activeModelMarkedAt = 0;
    }

    return "ok";
  }

  public async getModelSizeBytes(model: string, token: vscode.CancellationToken): Promise<number | undefined> {
    const settings = this.getSettings();
    const models = await this.fetchNativeModels(settings, token);
    const match = models.find((entry) => {
      if (entry.key === model) {
        return true;
      }
      return (entry.loaded_instances ?? []).some((instance) => instance.id === model);
    });
    return typeof match?.size_bytes === "number" ? match.size_bytes : undefined;
  }

  public async detectModelContextWindowTokens(token: vscode.CancellationToken): Promise<number | undefined> {
    const settings = this.getSettings();
    if (!settings.model) {
      return undefined;
    }

    try {
      const nativeModels = await this.fetchNativeModels(settings, token);
      const match = nativeModels.find((entry) => {
        if (entry.key === settings.model) {
          return true;
        }
        return (entry.loaded_instances ?? []).some((instance) => instance.id === settings.model);
      });
      if (!match) {
        return undefined;
      }

      // Prefer loaded instance runtime settings, which reflect how the model is actually loaded.
      for (const instance of match.loaded_instances ?? []) {
        const fromInstance = extractRuntimeContextWindowFromRecord(instance);
        if (fromInstance) {
          return fromInstance;
        }
      }

      // Some builds expose runtime context on the model entry itself.
      const fromEntry = extractRuntimeContextWindowFromRecord(match);
      if (fromEntry) {
        return fromEntry;
      }
    } catch {
      // Best effort.
    }

    return undefined;
  }

  public async isModelLoaded(model: string, token: vscode.CancellationToken): Promise<boolean> {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      return false;
    }

    const settings = this.getSettings();
    try {
      const nativeModels = await this.fetchNativeModels(settings, token);
      for (const entry of nativeModels) {
        const instances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : [];
        const hasMatchingInstance = instances.some((instance) => {
          const instanceId = typeof instance?.id === "string" ? instance.id.trim() : "";
          return instanceId === trimmedModel;
        });
        const entryKey = typeof entry.key === "string" ? entry.key.trim() : "";
        const isMatchingModel = entryKey === trimmedModel;
        if (hasMatchingInstance) {
          return true;
        }
        if (isMatchingModel && (instances.length > 0 || isNativeModelEntryLoading(entry))) {
          return true;
        }
      }
    } catch {
      // Best effort.
    }

    return false;
  }

  public getCachedThinkingSupport(model: string): boolean | undefined {
    return this.thinkingSupportCache.get(model);
  }

  public async detectModelThinkingSupport(
    token: vscode.CancellationToken,
    modelOverride?: string
  ): Promise<boolean> {
    const settings = this.getSettings();
    const model = (modelOverride ?? settings.model).trim();
    if (!model) {
      return false;
    }

    const cached = this.thinkingSupportCache.get(model);
    if (typeof cached === "boolean") {
      return cached;
    }

    const existingProbe = this.thinkingSupportProbePromises.get(model);
    if (existingProbe) {
      return existingProbe;
    }

    const probePromise = this.computeThinkingSupport(model, settings, token).then((supported) => {
      this.thinkingSupportCache.set(model, supported);
      return supported;
    }).finally(() => {
      if (this.thinkingSupportProbePromises.get(model) === probePromise) {
        this.thinkingSupportProbePromises.delete(model);
      }
    });
    this.thinkingSupportProbePromises.set(model, probePromise);
    return probePromise;
  }

  private async computeThinkingSupport(
    model: string,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<boolean> {
    await this.loadModel(model, token);

    try {
      const nativeModels = await this.fetchNativeModels(settings, token);
      const match = nativeModels.find((entry) => {
        if (entry.key === model) {
          return true;
        }
        return (entry.loaded_instances ?? []).some((instance) => instance.id === model);
      });

      if (match) {
        const fromMetadata = extractReasoningSupportFromRecord(match);
        if (typeof fromMetadata === "boolean") {
          console.info(`[LSPilot] Thinking support for "${model}" from metadata: ${fromMetadata ? "supported" : "unsupported"}`);
          return fromMetadata;
        }
      }
    } catch {
      // Best effort.
    }

    const fromProbe = await this.probeThinkingSupport(model, settings, token);
    if (typeof fromProbe === "boolean") {
      console.info(`[LSPilot] Thinking support for "${model}" from runtime probe: ${fromProbe ? "supported" : "unsupported"}`);
      return fromProbe;
    }

    console.info(`[LSPilot] Thinking support for "${model}" could not be confirmed; defaulting to unsupported.`);
    return false;
  }

  private async probeThinkingSupport(
    model: string,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<boolean | undefined> {
    try {
      const result = await this.nativeChat(
        {
          model,
          input: "Think through this carefully, then return only the final number: 1733 * 1729",
          reasoning: "on",
          max_output_tokens: 96,
          temperature: 0
        },
        settings,
        token,
        Math.min(settings.chatTimeoutMs, 20000)
      );

      if (typeof result.reasoning === "string" && result.reasoning.trim().length > 0) {
        return true;
      }

      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isExplicitNoThinkingSupportMessage(message)) {
        return false;
      }
      if (isThinkingParameterRejectedMessage(message)) {
        return false;
      }

      return undefined;
    }
  }

  public async generateInlineCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      return undefined;
    }

    if (!settings.model) {
      return undefined;
    }

    const model = settings.model;
    await this.loadModel(model, token);
    const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const suffix = document.getText(new vscode.Range(position, document.lineAt(document.lineCount - 1).range.end));

    const prompt = `<|fim_prefix|>${prefix.slice(-12000)}<|fim_suffix|>${suffix.slice(0, 4000)}<|fim_middle|>`;

    const raw = await this.textCompletion(
      {
        model,
        prompt,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream: false
      },
      settings,
      token
    );

    const cleaned = cleanCompletion(raw.text, suffix, settings.maxLines);
    return cleaned || undefined;
  }

  public async generateChatResponse(
    history: ChatHistoryMessage[],
    token: vscode.CancellationToken,
    onUpdate?: (chunk: { response: string; reasoning?: string; usage?: ChatTokenUsage }) => void,
    tools?: any[],
    options?: { enableThinking?: boolean }
  ): Promise<{ model: string; response: string; reasoning?: string; usage?: ChatTokenUsage; tool_calls?: any[] }> {
    const settings = this.getSettings();
    const model = await this.resolveModel(settings);
    await this.loadModel(model, token);

    let contextualHistory = history.slice(-20);
    
    // Ensure at least one user message is present to satisfy LM Studio jinja templates
    if (!contextualHistory.some(m => m.role === "user")) {
      const lastUser = [...history].reverse().find(m => m.role === "user");
      if (lastUser) {
        contextualHistory = [lastUser, ...contextualHistory];
      } else {
        contextualHistory = [{ role: "user", content: "Continue." } as ChatHistoryMessage, ...contextualHistory];
      }
    }

    const thinkingRequested = options?.enableThinking !== false;
    if (!thinkingRequested) {
      return this.generateReasoningOffChatResponse(contextualHistory, model, settings, token);
    }

    // Fetch dynamic context window or use -1 to let LM Studio use all available context
    const detectedContext = await this.detectModelContextWindowTokens(token);
    const maxTokensToUse = detectedContext && detectedContext > 0 ? detectedContext : -1;

    const messages = [
      { role: "system", content: settings.chatSystemPrompt },
      ...contextualHistory.map((message) => {
        const msg: any = { role: message.role };
        if (message.content != null && message.content !== "") {
          msg.content = message.content.slice(-12000);
        }
        if (message.tool_calls) {
          msg.tool_calls = message.tool_calls;
        }
        if (message.name) {
          msg.name = message.name;
        }
        if (message.tool_call_id) {
          msg.tool_call_id = message.tool_call_id;
        }
        return msg;
      })
    ];

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      tools,
      max_tokens: maxTokensToUse,
      temperature: settings.temperature
    };
    // /v1/chat/completions in LM Studio follows OpenAI-compatible fields.

    const runRequest = async (body: Record<string, unknown>): Promise<{ text: string; reasoning?: string; usage?: ChatTokenUsage; tool_calls?: any[] }> => {
      if (onUpdate) {
        return this.chatCompletionStream(body, settings, token, onUpdate, settings.chatTimeoutMs);
      }
      return this.chatCompletion(body, settings, token, settings.chatTimeoutMs);
    };

    const result = await runRequest(requestBody);

    return { model, response: result.text.trim(), reasoning: result.reasoning, usage: result.usage, tool_calls: result.tool_calls };
  }

  private getLatestUserMessage(history: ChatHistoryMessage[]): string | undefined {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const msg = history[i];
      if (msg.role !== "user") {
        continue;
      }
      const trimmed = typeof msg.content === "string" ? msg.content.trim() : "";
      if (trimmed.length > 0) {
        return trimmed.slice(-12_000);
      }
    }
    return undefined;
  }

  private buildReasoningOffBootstrapInput(history: ChatHistoryMessage[], systemPrompt: string): string {
    const offInstruction =
      `${systemPrompt}\n\n` +
      "Thinking mode is OFF. Do not output chain-of-thought, reasoning traces, or a 'Thinking Process'. " +
      "Return only your final answer.";

    const transcriptLines: string[] = [];
    for (const msg of history.slice(-20)) {
      if (msg.role === "tool") {
        continue;
      }
      const raw = typeof msg.content === "string" ? msg.content.trim() : "";
      if (!raw) {
        continue;
      }
      const clipped = raw.length > 2_000 ? `${raw.slice(-2_000)}\n...[truncated]` : raw;
      transcriptLines.push(`${msg.role.toUpperCase()}: ${clipped}`);
    }

    if (transcriptLines.length === 0) {
      return `${offInstruction}\n\nUSER: Continue.\n\nASSISTANT:`;
    }

    return `${offInstruction}\n\nConversation so far:\n\n${transcriptLines.join("\n\n")}\n\nASSISTANT:`;
  }

  private async generateReasoningOffChatResponse(
    history: ChatHistoryMessage[],
    model: string,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<{ model: string; response: string; reasoning?: string; usage?: ChatTokenUsage; tool_calls?: any[] }> {
    const previousResponseId = this.reasoningOffResponseIdByModel.get(model);
    const input = previousResponseId
      ? this.getLatestUserMessage(history) ?? "Continue."
      : this.buildReasoningOffBootstrapInput(history, settings.chatSystemPrompt);

    const requestBody: Record<string, unknown> = {
      model,
      input,
      reasoning: "off",
      max_output_tokens: settings.chatMaxTokens,
      temperature: settings.temperature
    };

    if (previousResponseId) {
      requestBody.previous_response_id = previousResponseId;
    }

    const result = await this.nativeChat(requestBody, settings, token, settings.chatTimeoutMs);
    if (result.responseId) {
      this.reasoningOffResponseIdByModel.set(model, result.responseId);
    } else {
      this.reasoningOffResponseIdByModel.delete(model);
    }

    return {
      model,
      response: result.text.trim(),
      reasoning: undefined,
      usage: result.usage,
      tool_calls: undefined
    };
  }

  private async resolveModel(settings: LSPilotSettings): Promise<string> {
    if (settings.model) {
      return settings.model;
    }
    throw new Error("No model selected. Run \"LSPilot: Select Model\" and pick a chat/completion model.");
  }

  private async fetchModels(
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<Array<{ id?: string }>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      let response: Response;
      try {
        response = await fetch(`${settings.baseUrl}/models`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal
        });
      } catch (error) {
        throw new Error(formatLMStudioRequestError(error, settings, "/models"));
      }

      if (!response.ok) {
        throw new Error(`LM Studio /models failed (${response.status})`);
      }

      const json = (await response.json()) as ModelsResponse;
      return json.data ?? [];
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async fetchNativeModels(settings: LSPilotSettings, token: vscode.CancellationToken): Promise<NativeModelEntry[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      const nativeApiBase = this.getNativeApiBase(settings.baseUrl);
      let response: Response;
      try {
        response = await fetch(`${nativeApiBase}/api/v1/models`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal
        });
      } catch (error) {
        throw new Error(formatLMStudioRequestError(error, settings, "/models"));
      }

      if (!response.ok) {
        throw new Error(`LM Studio /api/v1/models failed (${response.status})`);
      }

      const json = (await response.json()) as NativeModelsResponse;
      return Array.isArray(json.models) ? json.models : [];
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async textCompletion(
    body: Record<string, unknown>,
    settings: LSPilotSettings,
    token: vscode.CancellationToken,
    timeoutMs = settings.timeoutMs
  ): Promise<{ text: string; usage?: ChatTokenUsage }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      let response: Response;
      try {
        response = await fetch(`${settings.baseUrl}/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        throw new Error(formatLMStudioRequestError(error, settings, "/completions", "lspilot.timeoutMs"));
      }

      const json = (await response.json()) as { choices?: Array<{ text?: string }>, error?: { message?: string }, usage?: Record<string, unknown> };
      if (!response.ok) {
        throw new Error(json.error?.message || `LM Studio request failed (${response.status})`);
      }

      let text = "";
      if (json.choices && json.choices.length > 0 && typeof json.choices[0].text === "string") {
         text = json.choices[0].text;
      }
      return { text };
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async chatCompletion(
    body: Record<string, unknown>,
    settings: LSPilotSettings,
    token: vscode.CancellationToken,
    timeoutMs = settings.timeoutMs
  ): Promise<{ text: string; reasoning?: string; usage?: ChatTokenUsage; tool_calls?: any[] }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      let response: Response;
      try {
        response = await fetch(`${settings.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        const timeoutKey = timeoutMs === settings.chatTimeoutMs ? "lspilot.chatTimeoutMs" : "lspilot.timeoutMs";
        throw new Error(formatLMStudioRequestError(error, settings, "/chat/completions", timeoutKey));
      }

      const json = (await response.json()) as ChatCompletionResponse;
      if (!response.ok) {
        throw new Error(json.error?.message || `LM Studio request failed (${response.status})`);
      }

      const parsed = extractReasoningAndResponse(json);
      return { ...parsed, usage: extractTokenUsage(json) };
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async chatCompletionStream(
    body: Record<string, unknown>,
    settings: LSPilotSettings,
    token: vscode.CancellationToken,
    onUpdate: (chunk: { response: string; reasoning?: string; usage?: ChatTokenUsage; tool_calls?: any[] }) => void,
    timeoutMs = settings.timeoutMs
  ): Promise<{ text: string; reasoning?: string; usage?: ChatTokenUsage; tool_calls?: any[] }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      let response: Response;
      try {
        response = await fetch(`${settings.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
          signal: controller.signal
        });
      } catch (error) {
        const timeoutKey = timeoutMs === settings.chatTimeoutMs ? "lspilot.chatTimeoutMs" : "lspilot.timeoutMs";
        throw new Error(formatLMStudioRequestError(error, settings, "/chat/completions", timeoutKey));
      }

      if (!response.ok) {
        let errorMessage = `LM Studio request failed (${response.status})`;
        try {
          const json = (await response.json()) as ChatCompletionResponse;
          errorMessage = json.error?.message || errorMessage;
        } catch {
          // Ignore parse errors and surface status.
        }
        throw new Error(errorMessage);
      }

      if (!response.body) {
        return this.chatCompletion({ ...body, stream: false }, settings, token, timeoutMs);
      }

      let accumulatedResponse = "";
      let accumulatedReasoning = "";
      let lastEmittedResponse = "";
      let lastEmittedReasoning = "";
      let lastUsage: ChatTokenUsage | undefined;
      const accumulatedToolCalls: any[] = [];

      for await (const data of readSseEventData(response.body)) {
        if (!data || data === "[DONE]") {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (!parsed || typeof parsed !== "object") {
          continue;
        }

        const parsedRecord = parsed as {
          error?: { message?: string };
          choices?: Array<any>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        if (parsedRecord.error?.message) {
          throw new Error(parsedRecord.error.message);
        }

        const chunkUsage = extractTokenUsage(parsedRecord as ChatCompletionResponse);
        if (chunkUsage) {
          lastUsage = chunkUsage;
        }

        const choice = parsedRecord.choices?.[0];
        if (!choice) {
          continue;
        }

        const delta = extractDeltaText(choice.delta);
        if (delta.content.length > 0) {
          accumulatedResponse += delta.content;
        }
        if (delta.reasoning.length > 0) {
          accumulatedReasoning += delta.reasoning;
        }
        
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!accumulatedToolCalls[index]) {
              accumulatedToolCalls[index] = { id: tc.id, type: tc.type, function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" } };
            } else {
              if (tc.id) accumulatedToolCalls[index].id = tc.id;
              if (tc.type) accumulatedToolCalls[index].type = tc.type;
              if (tc.function?.name) accumulatedToolCalls[index].function.name += tc.function.name;
              if (tc.function?.arguments) accumulatedToolCalls[index].function.arguments += tc.function.arguments;
            }
          }
        }

        const messageContent = extractTextFromMessageContent((choice.message as Record<string, unknown> | undefined)?.content);
        if (messageContent.length > accumulatedResponse.length) {
          accumulatedResponse = messageContent;
        }

        const messageReasoning = extractTextFromMessageContent(
          (choice.message as Record<string, unknown> | undefined)?.reasoning_content
        );
        if (messageReasoning.length > accumulatedReasoning.length) {
          accumulatedReasoning = messageReasoning;
        }

        const textFallback = extractTextFromMessageContent(choice.text);
        if (textFallback.length > accumulatedResponse.length) {
          accumulatedResponse = textFallback;
        }

        const displayed = mergeDisplayedResponse(accumulatedResponse, accumulatedReasoning);
        const reasoningForEmit = displayed.reasoning ?? "";
        
        const toolCallsForEmit = accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined;
        let toolsChanged = false;
        if (delta.tool_calls && delta.tool_calls.length > 0) toolsChanged = true;

        if (displayed.text !== lastEmittedResponse || reasoningForEmit !== lastEmittedReasoning || toolsChanged) {
          lastEmittedResponse = displayed.text;
          lastEmittedReasoning = reasoningForEmit;
          onUpdate({ response: displayed.text, reasoning: displayed.reasoning, usage: lastUsage, tool_calls: toolCallsForEmit });
        }
      }
      
      const toolCalls = accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined;
      return { ...mergeDisplayedResponse(accumulatedResponse, accumulatedReasoning), usage: lastUsage, tool_calls: toolCalls };
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async nativeChat(
    body: Record<string, unknown>,
    settings: LSPilotSettings,
    token: vscode.CancellationToken,
    timeoutMs = settings.chatTimeoutMs
  ): Promise<{ text: string; reasoning?: string; usage?: ChatTokenUsage; responseId?: string }> {
    const nativeApiBase = this.getNativeApiBase(settings.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      let response: Response;
      try {
        response = await fetch(`${nativeApiBase}/api/v1/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        throw new Error(formatLMStudioRequestError(error, settings, "/api/v1/chat", "lspilot.chatTimeoutMs"));
      }

      const json = (await response.json()) as NativeChatResponse;
      if (!response.ok) {
        throw new Error(json.error?.message || `LM Studio native chat failed (${response.status})`);
      }

      const parsed = extractNativeChatOutput(json);
      return {
        ...parsed,
        usage: extractNativeUsage(json),
        responseId: typeof json.response_id === "string" ? json.response_id : undefined
      };
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async warmupModelWithChatCompletion(
    model: string,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<void> {
    await this.chatCompletion(
      {
        model,
        messages: [
          { role: "system", content: settings.systemPrompt },
          { role: "user", content: "Return exactly: ok" }
        ],
        temperature: 0,
        max_tokens: 8,
        stream: false
      },
      settings,
      token
    );
  }

  private getNativeApiBase(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/v1$/, "");
  }

  private async requestModelUnload(
    body: Record<string, string>,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<"ok" | "unsupported"> {
    const nativeApiBase = this.getNativeApiBase(settings.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.modelLoadTimeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      let response: Response;
      try {
        response = await fetch(`${nativeApiBase}/api/v1/models/unload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        const code = getErrorCode(error);
        if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ETIMEDOUT") {
          throw new Error(formatLMStudioRequestError(error, settings, "/api/v1/models/unload"));
        }

        if (error instanceof Error && error.message === "This operation was aborted") {
          throw new Error(formatLMStudioRequestError(error, settings, "/api/v1/models/unload"));
        }

        throw error;
      }

      // Older LM Studio versions may not expose explicit unload; treat this as no-op.
      if (response.status === 404 || response.status === 405) {
        return "unsupported";
      }

      if (!response.ok) {
        let details = "";
        try {
          const parsed = (await response.json()) as { error?: { message?: string } | string; message?: string };
          if (typeof parsed.error === "string") {
            details = parsed.error;
          } else if (parsed.error && typeof parsed.error.message === "string") {
            details = parsed.error.message;
          } else if (typeof parsed.message === "string") {
            details = parsed.message;
          }
        } catch {
          // Ignore parse errors and keep HTTP status context.
        }

        throw new Error(details || `LM Studio model unload failed (${response.status})`);
      }

      return "ok";
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }
}
