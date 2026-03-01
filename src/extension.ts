import * as vscode from "vscode";

interface LSPilotSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  minRequestGapMs: number;
  maxLines: number;
  systemPrompt: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    text?: string;
  }>;
  error?: {
    message?: string;
  };
}

class LMStudioClient {
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
      minRequestGapMs: config.get<number>("minRequestGapMs", 300),
      maxLines: config.get<number>("maxLines", 8),
      systemPrompt: config.get<string>(
        "systemPrompt",
        "You are a coding assistant that returns only the next code continuation. Do not explain. Do not wrap output in markdown fences."
      )
    };
  }

  public async testConnection(token: vscode.CancellationToken): Promise<{ model: string; sample: string }> {
    const settings = this.getSettings();
    const model = await this.resolveModel(settings, token);
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

  public async generateInlineCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      return undefined;
    }

    const model = await this.resolveModel(settings, token);
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

  private async resolveModel(settings: LSPilotSettings, token: vscode.CancellationToken): Promise<string> {
    if (settings.model) {
      return settings.model;
    }

    const now = Date.now();
    if (this.cachedModel && now - this.modelCacheTimestamp < this.modelCacheTtlMs) {
      return this.cachedModel;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      const response = await fetch(`${settings.baseUrl}/models`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`LM Studio /models failed (${response.status})`);
      }

      const json = (await response.json()) as { data?: Array<{ id?: string }> };
      const model = json.data?.find((entry) => entry.id)?.id;
      if (!model) {
        throw new Error("No loaded models found. Load a model in LM Studio or set lspilot.model.");
      }

      this.cachedModel = model;
      this.modelCacheTimestamp = now;
      return model;
    } finally {
      clearTimeout(timeout);
      cancelListener.dispose();
    }
  }

  private async chatCompletion(
    body: Record<string, unknown>,
    settings: LSPilotSettings,
    token: vscode.CancellationToken
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

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

export function activate(context: vscode.ExtensionContext): void {
  const client = new LMStudioClient();
  const lastRequestByUri = new Map<string, number>();

  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const settings = client.getSettings();
      if (!settings.enabled) {
        return [];
      }

      const now = Date.now();
      const key = document.uri.toString();
      const last = lastRequestByUri.get(key) ?? 0;
      if (now - last < settings.minRequestGapMs) {
        return [];
      }
      lastRequestByUri.set(key, now);

      const generated = await client.generateInlineCompletion(document, position, token);
      if (!generated) {
        return [];
      }

      return [new vscode.InlineCompletionItem(generated, new vscode.Range(position, position))];
    }
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.commands.registerCommand("lspilot.triggerInlineCompletion", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }),
    vscode.commands.registerCommand("lspilot.testConnection", async () => {
      const tokenSource = new vscode.CancellationTokenSource();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "LSPilot: Testing LM Studio connection",
          cancellable: true
        },
        async (_progress, progressToken) => {
          const cancelSub = progressToken.onCancellationRequested(() => tokenSource.cancel());
          try {
            const result = await client.testConnection(tokenSource.token);
            const sample = result.sample || "(empty response)";
            vscode.window.showInformationMessage(`LSPilot connected to model "${result.model}". Sample: ${sample}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`LSPilot connection failed: ${message}`);
          } finally {
            cancelSub.dispose();
            tokenSource.dispose();
          }
        }
      );
    })
  );
}

export function deactivate(): void {
  // No background resources to clean up.
}
