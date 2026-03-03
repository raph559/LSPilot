import * as vscode from "vscode";
import { LMStudioClient } from "../client/lmStudioClient";
import type { ChatHistoryMessage } from "../types";
import { createChatWebviewHtml } from "./webviewHtml";

export class LSPilotChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lspilot.chatView";

  private view: vscode.WebviewView | undefined;
  private history: ChatHistoryMessage[] = [];
  private busy = false;
  private activeRequest: vscode.CancellationTokenSource | undefined;

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
    this.postState();
  }

  public clearChat(showNotification = false): void {
    this.activeRequest?.cancel();
    this.activeRequest?.dispose();
    this.activeRequest = undefined;
    this.busy = false;
    this.history = [];
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
        this.postState();
      });

      const assistantMessage = this.history[assistantIndex];
      if (assistantMessage && assistantMessage.role === "assistant") {
        assistantMessage.content = result.response || "(empty response)";
        assistantMessage.thinking = result.reasoning;
      }

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

    const settings = this.client.getSettings();
    const modelLabel = settings.model || "None";

    void this.view.webview.postMessage({
      type: "state",
      busy: this.busy,
      modelLabel,
      messages: this.history
    });
  }
}
