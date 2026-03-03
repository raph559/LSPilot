import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
// @ts-ignore
import markdownItImsize from "markdown-it-imsize";
// @ts-ignore
import markdownItHighlightjs from "markdown-it-highlightjs";
import hljs from "highlight.js";

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true
})
.use(markdownItImsize)
.use(markdownItHighlightjs, { 
  auto: false, 
  code: true, 
  inline: false,
  format: function (code: string, lang: string) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    let highlighted = hljs.highlight(code, { language }).value;
    // Add line numbers
    if (highlighted.endsWith('\n')) {
      highlighted = highlighted.slice(0, -1);
    }
    return '<span class="ln"></span>' + highlighted.replace(/\n/g, '\n<span class="ln"></span>');
  }
});

const defaultFence = md.renderer.rules.fence || function (tokens: any[], idx: number, options: any, env: any, self: any) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.fence = function (tokens: any[], idx: number, options: any, env: any, self: any) {
  const token = tokens[idx];
  const lang = token.info ? token.info.trim().split(' ')[0] : 'plaintext';
  const rawHtml = defaultFence(tokens, idx, options, env, self);
  
  return `
    <div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-block-lang">${lang}</span>
        <button class="code-block-copy" title="Copy code" onclick="copyCode(this)">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
            <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
          </svg>
        </button>
      </div>
      <div class="code-block-body">
        ${rawHtml}
      </div>
    </div>
  `;
};

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
  private modelLoadInProgress = false;
  private previouslyLoadedModel: string | undefined;
  private lastTokenUsage: ChatTokenUsage | undefined;

  public constructor(private readonly client: LMStudioClient, private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = createChatWebviewHtml(webviewView.webview, this.extensionUri);

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

    if (message.type === "stop") {
      if (this.activeRequest) {
        this.activeRequest.cancel();
      }
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

        try {
          assistantMessage.renderedContent = md.render(assistantMessage.content) as string;
          if (assistantMessage.thinking) {
            assistantMessage.renderedThinking = md.render(assistantMessage.thinking) as string;
          }
        } catch {
          // Fallback handled in postState
        }

        if (chunk.usage) {
          this.lastTokenUsage = chunk.usage;
        }
        this.postState();
      });

      const assistantMessage = this.history[assistantIndex];
      if (assistantMessage && assistantMessage.role === "assistant") {
        assistantMessage.content = result.response || (result.reasoning ? "" : "(empty response)");
        assistantMessage.thinking = result.reasoning;
        assistantMessage.generationTimeMs = Date.now() - startTimeMs;

        try {
          assistantMessage.renderedContent = md.render(assistantMessage.content) as string;
          if (assistantMessage.thinking) {
            assistantMessage.renderedThinking = md.render(assistantMessage.thinking) as string;
          }
        } catch {
          // Fallback handled in postState
        }
      }
      if (result.usage) {
        this.lastTokenUsage = result.usage;
      }

      this.history = this.history.slice(-30);
    } catch (error) {
      if (tokenSource.token.isCancellationRequested) {
        // Keep partial response but mark as completed
        const assistantMessage = this.history[assistantIndex];
        if (assistantMessage && assistantMessage.role === "assistant") {
          const suffix = "\n\n_[Aborted by user]_";
          assistantMessage.content = assistantMessage.content ? assistantMessage.content + suffix : "_[Aborted by user]_";
          assistantMessage.generationTimeMs = Date.now() - startTimeMs;
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);

        const assistantMessage = this.history[assistantIndex];
        if (assistantMessage && assistantMessage.role === "assistant") {
          assistantMessage.content = assistantMessage.content ? `${assistantMessage.content}\n\n**Error:** ${message}` : `Error: ${message}`;
          assistantMessage.generationTimeMs = Date.now() - startTimeMs;
        } else {
          this.history.push({
            role: "assistant",
            content: `Error: ${message}`,
            generationTimeMs: Date.now() - startTimeMs
          });
        }
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

    // Parse markdown before sending to webview
    const renderedMessages = this.history.map((msg) => {
      let renderedContent: string | undefined;
      let renderedThinking: string | undefined;
      try {
        renderedContent = md.render(msg.content) as string;
        if (msg.thinking) {
          renderedThinking = md.render(msg.thinking) as string;
        }
      } catch (e) {
        renderedContent = msg.content;
        renderedThinking = msg.thinking;
      }
      return {
        ...msg,
        renderedContent,
        renderedThinking
      };
    });

    void this.view.webview.postMessage({
      type: "state",
      busy: this.busy,
      busyStartTimeMs: this.busyStartTimeMs,
      modelLabel,
      modelLoading: this.modelLoadInProgress,
      messages: renderedMessages,
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
      if (this.modelLoadInProgress) {
        this.modelLoadInProgress = false;
      }
      return;
    }

    this.contextProbeInFlight = true;
    let stateChanged = false;
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      let detected = await this.client.detectModelContextWindowTokens(tokenSource.token);

      // If no runtime context is detected, it usually means the model isn't active in VRAM yet.
      // Eagerly loading it ensures we can fetch the exact n_ctx constraint for the progress bar.
      // We only do this once per selected model and avoid doing it if a prompt is already running.
      if (!detected && !this.busy && this.previouslyLoadedModel !== settings.model) {
        this.previouslyLoadedModel = settings.model;
        this.modelLoadInProgress = true;
        this.postState(); // Update UI to show loading state
        try {
          await this.client.loadModel(settings.model, tokenSource.token);
          detected = await this.client.detectModelContextWindowTokens(tokenSource.token);
        } catch {
          this.previouslyLoadedModel = undefined; // Retry later if it failed
        } finally {
          this.modelLoadInProgress = false;
          stateChanged = true;
        }
      }

      if (typeof detected === "number" && detected > 0 && detected !== this.detectedContextWindowTokens) {
        this.detectedContextWindowTokens = detected;
        stateChanged = true;
      }
    } catch {
      // Best effort only.
    } finally {
      tokenSource.dispose();
      this.contextProbeInFlight = false;
      if (stateChanged) {
        this.postState();
      }
    }
  }
}
