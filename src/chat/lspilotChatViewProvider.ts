import * as vscode from "vscode";
import { LMStudioClient } from "../client/lmStudioClient";
import type { ChatContextUsage, ChatHistoryMessage, ChatTokenUsage } from "../types";
import { createChatWebviewHtml } from "./webviewHtml";

export class LSPilotChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lspilot.chatView";

  private view: vscode.WebviewView | undefined;
  private history: ChatHistoryMessage[] = [];
  private busy = false;
  private activeRequest: vscode.CancellationTokenSource | undefined;
  private busyStartTimeMs: number | undefined;
  private detectedContextWindowTokens: number | undefined;
  private contextProbeInFlight = false;
  private previouslyLoadedModel: string | undefined;
  private lastTokenUsage: ChatTokenUsage | undefined;

  public constructor(private readonly client: LMStudioClient) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = createChatWebviewHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    this.postState();
  }

  public refresh(): void {
    this.detectedContextWindowTokens = undefined;
    this.postState();
  }

  public clearChat(showNotification = false): void {
    this.activeRequest?.cancel();
    this.activeRequest?.dispose();
    this.activeRequest = undefined;
    this.busyStartTimeMs = undefined;
    this.busy = false;
    this.history = [];
    this.lastTokenUsage = undefined;
    this.postState();

    if (showNotification) {
      vscode.window.showInformationMessage("LSPilot chat cleared.");
    }
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    if (!rawMessage || typeof rawMessage !== "object") {
      return;
    }

    const message = rawMessage as { type?: string; text?: unknown };

    if (message.type === "ready") {
      this.postState();
      return;
    }

    if (message.type === "clear") {
      this.clearChat();
      return;
    }

    if (message.type === "selectModel") {
      await vscode.commands.executeCommand("lspilot.selectModel");
      return;
    }

    if (message.type === "send" && typeof message.text === "string") {
      await this.sendUserMessage(message.text);
    }
  }

  private async sendUserMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (this.busy) {
      vscode.window.showInformationMessage("LSPilot is already generating a response.");
      return;
    }

    this.history.push({ role: "user", content: trimmed });
    this.history = this.history.slice(-30);

    const requestHistory = [...this.history];
    this.history.push({ role: "assistant", content: "" });

    this.busy = true;
    const startTimeMs = Date.now();
    this.busyStartTimeMs = startTimeMs;
    this.postState();

    const tokenSource = new vscode.CancellationTokenSource();
    this.activeRequest = tokenSource;
    const assistantIndex = this.history.length - 1;

    try {
      const result = await this.client.generateChatResponse(requestHistory, tokenSource.token, (chunk) => {
        if (this.activeRequest !== tokenSource) {
          return;
        }

        const assistantMessage = this.history[assistantIndex];
        if (!assistantMessage || assistantMessage.role !== "assistant") {
          return;
        }

        assistantMessage.content = chunk.response;
        assistantMessage.thinking = chunk.reasoning;
        assistantMessage.generationTimeMs = Date.now() - startTimeMs;
        if (chunk.usage) {
          this.lastTokenUsage = chunk.usage;
        }
        this.postState();
      });

      const assistantMessage = this.history[assistantIndex];
      if (assistantMessage && assistantMessage.role === "assistant") {
        assistantMessage.content = result.response || "(empty response)";
        assistantMessage.thinking = result.reasoning;
        assistantMessage.generationTimeMs = Date.now() - startTimeMs;
      }
      if (result.usage) {
        this.lastTokenUsage = result.usage;
      }

      this.history = this.history.slice(-30);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const assistantMessage = this.history[assistantIndex];
      if (assistantMessage && assistantMessage.role === "assistant") {
        assistantMessage.content = `Error: ${message}`;
        assistantMessage.thinking = undefined;
        assistantMessage.generationTimeMs = Date.now() - startTimeMs;
      } else {
        this.history.push({
          role: "assistant",
          content: `Error: ${message}`,
          generationTimeMs: Date.now() - startTimeMs
        });
      }

      this.history = this.history.slice(-30);
    } finally {
      if (this.activeRequest === tokenSource) {
        this.activeRequest = undefined;
        this.busyStartTimeMs = undefined;
      }
      tokenSource.dispose();
      this.busy = false;
      this.postState();
    }
  }

  private postState(): void {
    if (!this.view) {
      return;
    }

    void this.refreshDetectedContextWindow();

    const settings = this.client.getSettings();
    const modelLabel = settings.model || "None";
    const contextUsage = this.getEstimatedContextUsage();

    void this.view.webview.postMessage({
      type: "state",
      busy: this.busy,
      busyStartTimeMs: this.busyStartTimeMs,
      modelLabel,
      messages: this.history,
      contextUsage
    });
  }

  private getEstimatedContextUsage(): ChatContextUsage | undefined {
    const contextWindowTokens = this.detectedContextWindowTokens;
    if (!contextWindowTokens || contextWindowTokens <= 0) {
      return undefined;
    }

    let promptTokens = this.lastTokenUsage?.promptTokens || 0;
    let completionTokens = this.lastTokenUsage?.completionTokens || 0;
    let totalTokens = this.lastTokenUsage?.totalTokens || 0;

    // During generation, dynamically estimate newly added tokens so the progress bar updates in real time
    if (this.busy && this.history.length > 0 && !this.lastTokenUsage?.totalTokens) {
      // Small safety check: if lastTokenUsage was already populated by the stream (some models send it early), don't double count.
      // But typically we don't get chunk.usage until the end. We'll track if we need to fake it:
    }
    
    // Better logic: if we are busy, and the current token usage hasn't been emitted by the stream yet for this run
    // Actually, `this.lastTokenUsage` is from the *previous* request until overwritten. 
    // We can just add the estimation unconditionally until we receive a new chunk.usage.
    // Wait, chunk.usage sets this.lastTokenUsage. So if it is set, we still add to it? 
    // No, if chunk.usage is emitted during stream (rare, usually at the end), we don't want to add previous + new.
    // But since `chunk.usage` contains the real prompt + completion, if we just use the length of the string, we get a nice fallback.

    if (this.busy && this.history.length > 0) {
      const lastMsg = this.history[this.history.length - 1];
      if (lastMsg.role === "assistant") {
        const currentLen = (lastMsg.content?.length || 0) + (lastMsg.thinking?.length || 0);
        let extraUserLen = 0;
        if (this.history.length >= 2) {
          const preMsg = this.history[this.history.length - 2];
          if (preMsg.role === "user") {
            extraUserLen = preMsg.content?.length || 0;
          }
        }
        
        // Approx 3.5 chars per token for typical LLMs
        const estimatedNewTokens = Math.floor((currentLen + extraUserLen) / 3.5);
        totalTokens += estimatedNewTokens;
        completionTokens = (this.lastTokenUsage?.completionTokens || 0) + Math.floor(currentLen / 3.5);
      }
    }

    const usageRatio = Math.min(1, totalTokens / contextWindowTokens);
    const usagePercent = Math.round(usageRatio * 1000) / 10;
    const remaining = contextWindowTokens - totalTokens;
    const detailLines = [
      this.busy ? `Prompt: ~${promptTokens.toLocaleString()} tokens (Estimating...)` : `Prompt: ${promptTokens.toLocaleString()} tokens (LM Studio API)`,
      this.busy ? `Completion: ~${completionTokens.toLocaleString()} tokens` : `Completion: ${completionTokens.toLocaleString()} tokens (LM Studio API)`,
      `Total: ${this.busy ? '~' : ''}${totalTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()} tokens (${usagePercent.toFixed(1)}%)`,
      remaining >= 0
        ? `Remaining: ${remaining.toLocaleString()} tokens`
        : `Overflow: ${Math.abs(remaining).toLocaleString()} tokens`
    ];

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      contextWindowTokens,
      usageRatio,
      usagePercent,
      details: detailLines.join("\n")
    };
  }

  private async refreshDetectedContextWindow(): Promise<void> {
    if (this.contextProbeInFlight) {
      return;
    }

    const settings = this.client.getSettings();
    if (!settings.model) {
      if (this.detectedContextWindowTokens !== undefined) {
        this.detectedContextWindowTokens = undefined;
      }
      return;
    }

    this.contextProbeInFlight = true;
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      let detected = await this.client.detectModelContextWindowTokens(tokenSource.token);

      // If no runtime context is detected, it usually means the model isn't active in VRAM yet.
      // Eagerly loading it ensures we can fetch the exact n_ctx constraint for the progress bar.
      // We only do this once per selected model and avoid doing it if a prompt is already running.
      if (!detected && !this.busy && this.previouslyLoadedModel !== settings.model) {
        this.previouslyLoadedModel = settings.model;
        try {
          await this.client.loadModel(settings.model, tokenSource.token);
          detected = await this.client.detectModelContextWindowTokens(tokenSource.token);
        } catch {
          this.previouslyLoadedModel = undefined; // Retry later if it failed
        }
      }

      if (typeof detected === "number" && detected > 0 && detected !== this.detectedContextWindowTokens) {
        this.detectedContextWindowTokens = detected;
        this.postState();
      }
    } catch {
      // Best effort only.
    } finally {
      tokenSource.dispose();
      this.contextProbeInFlight = false;
    }
  }
}
