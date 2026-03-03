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

function extractReasoningAndResponse(response: ChatCompletionResponse): { text: string; reasoning?: string } {
  const choice = response.choices?.[0];
  if (!choice) {
    return { text: "" };
  }

  const rawText = extractCompletionText(response);
  const messageReasoning = extractTextFromMessageContent(choice.message?.reasoning_content);
  const choiceReasoning = typeof choice.reasoning_content === "string" ? choice.reasoning_content : "";
  const explicitReasoning = messageReasoning || choiceReasoning;
  return mergeDisplayedResponse(rawText, explicitReasoning);
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

function extractDeltaText(delta: unknown): { content: string; reasoning: string } {
  if (!delta || typeof delta !== "object") {
    return { content: "", reasoning: "" };
  }

  const record = delta as Record<string, unknown>;
  const content = extractTextFromMessageContent(record.content);
  const reasoningContent = extractTextFromMessageContent(record.reasoning_content);
  const reasoning = reasoningContent || extractTextFromMessageContent(record.reasoning);

  return { content, reasoning };
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

export class LMStudioClient {
  private cachedModel: string | undefined;
  private modelCacheTimestamp = 0;
  private readonly modelCacheTtlMs = 60_000;
  private modelLoadPromises = new Map<string, Promise<void>>();

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
  }

  public async listModels(token: vscode.CancellationToken): Promise<string[]> {
    const settings = this.getSettings();
    const models = await this.fetchModels(settings, token);
    const ids = models.map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    return filterGenerationModelIds(ids);
  }

  public async testConnection(token: vscode.CancellationToken): Promise<{ model: string; sample: string }> {
    const settings = this.getSettings();
    const model = await this.resolveModel(settings);
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
    const existing = this.modelLoadPromises.get(model);
    if (existing) {
      return existing;
    }
    const promise = this.doLoadModel(model, token).finally(() => {
      if (this.modelLoadPromises.get(model) === promise) {
        this.modelLoadPromises.delete(model);
      }
    });
    this.modelLoadPromises.set(model, promise);
    return promise;
  }

  private async doLoadModel(model: string, token: vscode.CancellationToken): Promise<void> {
    const settings = this.getSettings();
    const nativeApiBase = this.getNativeApiBase(settings.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.modelLoadTimeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
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
          return;
        }

        throw error;
      }
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  public async unloadModel(model: string, token: vscode.CancellationToken): Promise<void> {
    const settings = this.getSettings();
    const nativeModels = await this.fetchNativeModels(settings, token).catch(() => [] as NativeModelEntry[]);
    const explicitMatch = nativeModels.find((entry) => entry.key === model);
    const instanceIds = (explicitMatch?.loaded_instances ?? [])
      .map((instance) => instance.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const unloadTargets: Array<Record<string, string>> = [];
    if (instanceIds.length > 0) {
      unloadTargets.push(...instanceIds.map((instance_id) => ({ instance_id })));
    }
    unloadTargets.push({ model });

    let unloaded = false;
    let sawMissingInstanceId = false;
    let lastError: Error | undefined;

    for (const target of unloadTargets) {
      try {
        const result = await this.requestModelUnload(target, settings, token);
        if (result === "unsupported") {
          return;
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
      return;
    }
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
    onUpdate?: (chunk: { response: string; reasoning?: string; usage?: ChatTokenUsage }) => void
  ): Promise<{ model: string; response: string; reasoning?: string; usage?: ChatTokenUsage }> {
    const settings = this.getSettings();
    const model = await this.resolveModel(settings);

    const contextualHistory = history.slice(-20);
    const messages = [
      { role: "system", content: settings.chatSystemPrompt },
      ...contextualHistory.map((message) => ({
        role: message.role,
        content: message.content.slice(-6000)
      }))
    ];

    let result;
    if (onUpdate) {
      result = await this.chatCompletionStream(
        {
          model,
          messages,
          max_tokens: settings.chatMaxTokens,
          temperature: settings.temperature
        },
        settings,
        token,
        onUpdate,
        settings.chatTimeoutMs
      );
    } else {
      result = await this.chatCompletion(
        {
          model,
          messages,
          max_tokens: settings.chatMaxTokens,
          temperature: settings.temperature
        },
        settings,
        token,
        settings.chatTimeoutMs
      );
    }

    return { model, response: result.text.trim(), reasoning: result.reasoning, usage: result.usage };
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
  ): Promise<{ text: string; reasoning?: string; usage?: ChatTokenUsage }> {
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
    onUpdate: (chunk: { response: string; reasoning?: string; usage?: ChatTokenUsage }) => void,
    timeoutMs = settings.timeoutMs
  ): Promise<{ text: string; reasoning?: string; usage?: ChatTokenUsage }> {
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
          choices?: Array<Record<string, unknown>>;
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
        if (displayed.text !== lastEmittedResponse || reasoningForEmit !== lastEmittedReasoning) {
          lastEmittedResponse = displayed.text;
          lastEmittedReasoning = reasoningForEmit;
          onUpdate({ response: displayed.text, reasoning: displayed.reasoning, usage: lastUsage });
        }
      }

      return { ...mergeDisplayedResponse(accumulatedResponse, accumulatedReasoning), usage: lastUsage };
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
  ): Promise<{ text: string; reasoning?: string; usage?: ChatTokenUsage }> {
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
      return { ...parsed, usage: extractNativeUsage(json) };
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
