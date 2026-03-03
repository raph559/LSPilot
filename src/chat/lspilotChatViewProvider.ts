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
  private detectedContextWindowTokens: number | undefined;
  private contextProbeInFlight = false;
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
        this.lastTokenUsage = chunk.usage;
        this.postState();
      });

      const assistantMessage = this.history[assistantIndex];
      if (assistantMessage && assistantMessage.role === "assistant") {
        assistantMessage.content = result.response || "(empty response)";
        assistantMessage.thinking = result.reasoning;
      }
      this.lastTokenUsage = result.usage;

      this.history = this.history.slice(-30);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const assistantMessage = this.history[assistantIndex];
      if (assistantMessage && assistantMessage.role === "assistant") {
        assistantMessage.content = `Error: ${message}`;
        assistantMessage.thinking = undefined;
      } else {
        this.history.push({
          role: "assistant",
          content: `Error: ${message}`
        });
      }

      this.history = this.history.slice(-30);
    } finally {
      if (this.activeRequest === tokenSource) {
        this.activeRequest = undefined;
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
      modelLabel,
      messages: this.history,
      contextUsage
    });
  }

  private getEstimatedContextUsage(): ChatContextUsage | undefined {
    const contextWindowTokens = this.detectedContextWindowTokens;
    const usage = this.lastTokenUsage;
    if (!contextWindowTokens || contextWindowTokens <= 0 || !usage) {
      return undefined;
    }
    const usageRatio = Math.min(1, usage.totalTokens / contextWindowTokens);
    const usagePercent = Math.round(usageRatio * 1000) / 10;
    const remaining = contextWindowTokens - usage.totalTokens;
    const detailLines = [
      `Prompt: ${usage.promptTokens.toLocaleString()} tokens (LM Studio API)`,
      `Completion: ${usage.completionTokens.toLocaleString()} tokens (LM Studio API)`,
      `Total: ${usage.totalTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()} tokens (${usagePercent.toFixed(1)}%)`,
      remaining >= 0
        ? `Remaining: ${remaining.toLocaleString()} tokens`
        : `Overflow: ${Math.abs(remaining).toLocaleString()} tokens`
    ];

    return {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
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
      const detected = await this.client.detectModelContextWindowTokens(tokenSource.token);
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
