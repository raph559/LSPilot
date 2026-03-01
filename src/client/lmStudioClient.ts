import * as vscode from "vscode";
import type {
  ChatCompletionResponse,
  ChatHistoryMessage,
  LMStudioMessage,
  LSPilotSettings,
  ModelsResponse,
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
  endpoint: "/models" | "/chat/completions" | "/api/v1/models/load" | "/api/v1/models/unload",
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

function cleanCompletion(raw: string, suffix: string, maxLines: number): string {
  let text = raw.replace(/\r\n/g, "\n");

  text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, "");
  text = text.replace(/\n?```$/, "");

  if (suffix && text.startsWith(suffix)) {
    text = text.slice(suffix.length);
  }

  if (text.trim().length === 0) {
    return "";
  }

  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
  }

  return text;
}

export class LMStudioClient {
  private cachedModel: string | undefined;
  private modelCacheTimestamp = 0;
  private readonly modelCacheTtlMs = 60_000;

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

    return { model, sample: completion.trim() };
  }

  public async loadModel(model: string, token: vscode.CancellationToken): Promise<void> {
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

    const language = document.languageId || "plaintext";
    const prompt =
      `File language: ${language}\n` +
      "Continue the code at <cursor>. Return only the continuation text.\n" +
      "<prefix>\n" +
      prefix.slice(-12000) +
      "\n</prefix>\n" +
      "<suffix>\n" +
      suffix.slice(0, 4000) +
      "\n</suffix>\n" +
      "<cursor>";

    const raw = await this.chatCompletion(
      {
        model,
        messages: [
          { role: "system", content: settings.systemPrompt },
          { role: "user", content: prompt }
        ],
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        stream: false
      },
      settings,
      token
    );

    const cleaned = cleanCompletion(raw, suffix, settings.maxLines);
    return cleaned || undefined;
  }

  public async generateChatResponse(
    history: ChatHistoryMessage[],
    token: vscode.CancellationToken
  ): Promise<{ model: string; response: string }> {
    const settings = this.getSettings();
    const model = await this.resolveModel(settings);

    const contextualHistory = history.slice(-20).map((message) => ({
      role: message.role,
      content: message.content.slice(-6000)
    }));

    const messages: LMStudioMessage[] = [{ role: "system", content: settings.chatSystemPrompt }, ...contextualHistory];

    const raw = await this.chatCompletion(
      {
        model,
        messages,
        temperature: settings.temperature,
        max_tokens: settings.chatMaxTokens,
        stream: false
      },
      settings,
      token,
      settings.chatTimeoutMs
    );

    return { model, response: raw.trim() };
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

  private async chatCompletion(
    body: Record<string, unknown>,
    settings: LSPilotSettings,
    token: vscode.CancellationToken,
    timeoutMs = settings.timeoutMs
  ): Promise<string> {
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

      return extractCompletionText(json);
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
