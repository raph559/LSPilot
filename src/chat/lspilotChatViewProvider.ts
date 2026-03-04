import * as vscode from "vscode";
import * as path from "path";
import * as diff from "diff";
import MarkdownIt from "markdown-it";
// @ts-ignore
import markdownItImsize from "markdown-it-imsize";
import hljs from "highlight.js";

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
  highlight: function (str, lang) {
    let highlighted = '';
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch (__) {
        highlighted = md.utils.escapeHtml(str);
      }
    } else {
      highlighted = md.utils.escapeHtml(str);
    }
    
    // Add line numbers
    if (highlighted.endsWith('\n')) {
      highlighted = highlighted.slice(0, -1);
    }
    return '<span class="ln"></span>' + highlighted.replace(/\n/g, '\n<span class="ln"></span>');
  }
})
.use(markdownItImsize);

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
import { toolsDefinition, executeTool } from "./tools";
import { LSPilotDiffProvider } from "./lspilotDiffProvider";

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
  private thinkingEnabled = true;
  private modelSupportsThinking = false;
  private thinkingSupportProbeInFlight = false;
  private lastThinkingSupportModel: string | undefined;

  public constructor(private readonly client: LMStudioClient, private readonly extensionUri: vscode.Uri) {}

  private isSameFilePath(a: string, b: string): boolean {
    const normalizedA = path.normalize(a);
    const normalizedB = path.normalize(b);
    if (process.platform === "win32") {
      return normalizedA.toLowerCase() === normalizedB.toLowerCase();
    }
    return normalizedA === normalizedB;
  }

  private buildDiff(
    oldContent: string | null,
    newContent: string
  ): {
    additions: number;
    deletions: number;
    diffs: Array<{ added?: boolean; removed?: boolean; value: string; count?: number }>;
  } {
    let additions = 0;
    let deletions = 0;
    let diffs: Array<{ added?: boolean; removed?: boolean; value: string; count?: number }> = [];

    if (oldContent === null) {
      additions = newContent.split("\n").length;
      diffs = [{ added: true, value: newContent }];
    } else {
      diffs = diff.diffLines(oldContent, newContent);
      for (const change of diffs) {
        if (change.added) additions += change.count || 0;
        if (change.removed) deletions += change.count || 0;
      }
    }

    return { additions, deletions, diffs };
  }

  private coalescePendingFileEdit(fileEdit?: ChatHistoryMessage["fileEdit"]): void {
    if (!fileEdit) {
      return;
    }

    let baselineOldContent = fileEdit.oldContent;
    const pendingForSameFile: Array<NonNullable<ChatHistoryMessage["fileEdit"]>> = [];

    for (const msg of this.history) {
      if (msg.role !== "tool" || !msg.fileEdit) {
        continue;
      }
      const previous = msg.fileEdit;
      if (previous.applied || previous.discarded || previous.superseded) {
        continue;
      }
      if (!this.isSameFilePath(previous.filePath, fileEdit.filePath)) {
        continue;
      }

      pendingForSameFile.push(previous);
    }

    if (pendingForSameFile.length > 0) {
      baselineOldContent = pendingForSameFile[0].oldContent;
      for (const previous of pendingForSameFile) {
        previous.superseded = true;
      }
    }

    fileEdit.oldContent = baselineOldContent;

    const recalculated = this.buildDiff(fileEdit.oldContent, fileEdit.newContent);
    fileEdit.additions = recalculated.additions;
    fileEdit.deletions = recalculated.deletions;
    fileEdit.diffs = recalculated.diffs;

    const hasNetChange = fileEdit.oldContent === null
      ? true
      : fileEdit.oldContent !== fileEdit.newContent;

    if (!hasNetChange) {
      // No effective workspace change left to apply/undo.
      fileEdit.applied = true;
      fileEdit.superseded = true;
    }
  }

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
    this.lastThinkingSupportModel = undefined;
    this.client.resetReasoningOffSession();
    const model = this.client.getSettings().model?.trim();
    if (model) {
      this.client.clearThinkingSupportCache(model);
    } else {
      this.client.clearThinkingSupportCache();
    }
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
    this.client.resetReasoningOffSession();
    this.postState();

    if (showNotification) {
      vscode.window.showInformationMessage("LSPilot chat cleared.");
    }
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    if (!rawMessage || typeof rawMessage !== "object") {
      return;
    }

    const message = rawMessage as { type?: string; text?: unknown; index?: number; enableThinking?: unknown; enabled?: unknown };

    if (message.type === "ready") {
      this.postState();
      return;
    }

    if (message.type === "keepEdit" && typeof message.index === "number") {
      const msg = this.history[message.index];
      if (msg && msg.fileEdit) {
        if (msg.fileEdit.superseded) {
          return;
        }
        msg.fileEdit.applied = true;
        this.postState();
      }
      return;
    }

    if (message.type === "keepAllEdits") {
      for (const msg of this.history) {
        if (msg.role === "tool" && msg.fileEdit && !msg.fileEdit.discarded && !msg.fileEdit.applied && !msg.fileEdit.superseded) {
          msg.fileEdit.applied = true;
        }
      }
      this.postState();
      return;
    }

    if (message.type === "undoEdit" && typeof message.index === "number") {
      const msg = this.history[message.index];
      if (msg && msg.fileEdit) {
        const edit = msg.fileEdit;
        if (edit.superseded) {
          return;
        }
        try {
          if (edit.oldContent === null) {
            await vscode.workspace.fs.delete(vscode.Uri.file(edit.filePath));
          } else {
            await vscode.workspace.fs.writeFile(vscode.Uri.file(edit.filePath), Buffer.from(edit.oldContent, 'utf8'));
          }
          msg.fileEdit.discarded = true;
          this.postState();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to undo edit: ${e.message}`);
        }
      }
      return;
    }

    if (message.type === "undoAllEdits") {
      for (const msg of this.history) {
        if (msg.role === "tool" && msg.fileEdit && !msg.fileEdit.discarded && !msg.fileEdit.applied && !msg.fileEdit.superseded) {
          const edit = msg.fileEdit;
          try {
            if (edit.oldContent === null) {
              await vscode.workspace.fs.delete(vscode.Uri.file(edit.filePath));
            } else {
              await vscode.workspace.fs.writeFile(vscode.Uri.file(edit.filePath), Buffer.from(edit.oldContent, 'utf8'));
            }
            msg.fileEdit.discarded = true;
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to undo edit: ${e.message}`);
          }
        }
      }
      this.postState();
      return;
    }

    if (message.type === "showDiff" && typeof message.index === "number") {
      const msg = this.history[message.index];
      if (msg && msg.fileEdit) {
        const edit = msg.fileEdit;
        const fileName = edit.filePath.split(/[\\/]/).pop() || "file";
        const id = `edit-${message.index}-${Date.now()}`;
        
        LSPilotDiffProvider.getInstance().registerContent(id, edit.oldContent ?? "");
        
        const leftUri = vscode.Uri.parse(`lspilot-diff:${id}`);
        const rightUri = vscode.Uri.file(edit.filePath);
        const title = `LSPilot: ${fileName} (Original ↔ Edited)`;
        
        vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
      }
      return;
    }

    if (message.type === "openFile" && typeof message.index === "number") {
      const msg = this.history[message.index];
      if (msg && msg.role === "tool" && msg.resolvedPath) {
        try {
          vscode.workspace.openTextDocument(vscode.Uri.file(msg.resolvedPath)).then(doc => {
            vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
          });
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to open file: ${e.message}`);
        }
      }
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

    if (message.type === "toggleThinking") {
      const before = this.thinkingEnabled;
      if (typeof message.enabled === "boolean") {
        this.thinkingEnabled = message.enabled;
      } else {
        this.thinkingEnabled = !this.thinkingEnabled;
      }
      if (this.thinkingEnabled !== before) {
        const model = this.client.getSettings().model?.trim();
        this.client.resetReasoningOffSession(model);
      }
      this.postState();
      return;
    }

    if (message.type === "send" && typeof message.text === "string") {
      const requestedThinking = typeof message.enableThinking === "boolean" ? message.enableThinking : this.thinkingEnabled;
      const shouldEnableThinking = requestedThinking;
      await this.sendUserMessage(message.text, shouldEnableThinking);
    }
  }

  private async sendUserMessage(text: string, enableThinking: boolean): Promise<void> {
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

    const startTimeMs = Date.now();
    this.busyStartTimeMs = startTimeMs;
    this.busy = true;

    const tokenSource = new vscode.CancellationTokenSource();
    this.activeRequest = tokenSource;

    try {
      let runNext = true;
      while (runNext && !tokenSource.token.isCancellationRequested) {
        runNext = false;
        
        const requestHistory = [...this.history];
        this.history.push({ role: "assistant", content: "" });
        this.postState();

        const assistantIndex = this.history.length - 1;

        const result = await this.client.generateChatResponse(requestHistory, tokenSource.token, (chunk) => {
          if (this.activeRequest !== tokenSource) {
            return;
          }

          const assistantMessage = this.history[assistantIndex];
          if (!assistantMessage || assistantMessage.role !== "assistant") {
            return;
          }

          assistantMessage.content = chunk.response;
          assistantMessage.thinking = enableThinking ? chunk.reasoning : undefined;
          if (!enableThinking) {
            assistantMessage.renderedThinking = undefined;
          }

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
        }, toolsDefinition, { enableThinking });

        const assistantMessage = this.history[assistantIndex];
        if (assistantMessage && assistantMessage.role === "assistant") {
          if (result.tool_calls && result.tool_calls.length > 0) {
              assistantMessage.tool_calls = result.tool_calls;
          }

          const hasVisibleThinking = enableThinking && !!result.reasoning;
          assistantMessage.content = result.response || (hasVisibleThinking || result.tool_calls ? "" : "(empty response)");
          assistantMessage.thinking = enableThinking ? result.reasoning : undefined;
          if (!enableThinking) {
            assistantMessage.renderedThinking = undefined;
          }

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

        const selectedModel = this.client.getSettings().model;
        if (selectedModel) {
          const cachedSupport = this.client.getCachedThinkingSupport(selectedModel);
          if (typeof cachedSupport === "boolean" && this.modelSupportsThinking !== cachedSupport) {
            this.modelSupportsThinking = cachedSupport;
            this.lastThinkingSupportModel = selectedModel;
          }
        }
        
        this.postState();

        if (result.tool_calls && result.tool_calls.length > 0 && !tokenSource.token.isCancellationRequested) {
            runNext = true;
            for (const tc of result.tool_calls) {
               const toolResult = await executeTool(tc.function.name, tc.function.arguments);

               this.coalescePendingFileEdit(toolResult.fileEdit);
               
               let summaryInfo = tc.function.name;
               try {
                 const argsObj = JSON.parse(tc.function.arguments);
                 if (tc.function.name === "writeFile" || tc.function.name === "readFile") {
                   const file = (argsObj.filePath || "").split(/[\\/]/).pop();
                   summaryInfo += ` on <b>${file}</b>`;
                 } else if (tc.function.name === "runCommand") {
                   const cmd = argsObj.command || "";
                   const shortCmd = cmd.length > 20 ? cmd.substring(0, 20) + "..." : cmd;
                   summaryInfo += ` <code>${shortCmd}</code>`;
                 } else if (tc.function.name === "listDirectory") {
                   const dir = (argsObj.dirPath || "").split(/[\\/]/).pop() || '/';
                   summaryInfo += ` in <b>${dir}</b>`;
                 }
               } catch (e) {}

               this.history.push({
                   role: "tool",
                   name: tc.function.name,
                   toolSummary: summaryInfo,
                   tool_call_id: tc.id,
                   content: toolResult.text,
                   fileEdit: toolResult.fileEdit,
                   resolvedPath: toolResult.resolvedPath
               });
            }
            this.history = this.history.slice(-30);
            this.postState();
        } else {
            runNext = false;
            // Only record generation time once the full logic loop has fully executed and stopped.
            const firstAssistantMessage = this.history[assistantIndex];
            if (firstAssistantMessage) {
                firstAssistantMessage.generationTimeMs = Date.now() - startTimeMs;
                this.postState(); 
            }
        }
      }
      this.history = this.history.slice(-30);
    } catch (error) {
      const lastIndex = this.history.length - 1;
      if (tokenSource.token.isCancellationRequested) {
        // Keep partial response but mark as completed
        const assistantMessage = this.history[lastIndex];
        if (assistantMessage && assistantMessage.role === "assistant") {
          const suffix = "\n\n_[Aborted by user]_";
          assistantMessage.content = assistantMessage.content ? assistantMessage.content + suffix : "_[Aborted by user]_";
          assistantMessage.generationTimeMs = Date.now() - startTimeMs;
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);

        const assistantMessage = this.history[lastIndex];
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
    void this.refreshModelThinkingSupport();

    const settings = this.client.getSettings();
    const modelLabel = settings.model || "None";
    const contextUsage = this.getEstimatedContextUsage();

    // Render markdown lazily to prevent massive CPU overhead on every stream chunk
    const renderedMessages = this.history.map((msg, index) => {
      // During active generation, only the last message is changing.
      // We can safely cache the rendered markdown for all previous messages to prevent lag ("getting completely buggy").
      const isLastMessage = index === this.history.length - 1;
      
      if (!isLastMessage && msg.renderedContent !== undefined) {
        return msg;
      }

      let renderedContent: string | undefined;
      let renderedThinking: string | undefined;
      try {
        if (msg.role !== "tool") {
          renderedContent = md.render(msg.content) as string;
        } else {
          if (msg.fileEdit && msg.fileEdit.diffs) {
            let diffText = "";
            for (const part of msg.fileEdit.diffs) {
              const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
              const lines = part.value.split('\n');
              if (lines[lines.length - 1] === "") lines.pop();
              for (const line of lines) {
                diffText += `${prefix}${line}\n`;
              }
            }
            renderedContent = md.render("```diff\n" + diffText + "```") as string;
          } else {
            let lang = "plaintext";
            if (msg.name === "runCommand") lang = "bash";
            else if (msg.name === "writeFile" || msg.name === "readFile") {
              try {
                 const argsObj = JSON.parse(msg.tool_call_id ? this.history.find(m => m.tool_calls?.some((t: any) => t.id === msg.tool_call_id))?.tool_calls?.find((t:any) => t.id === msg.tool_call_id)?.function?.arguments || "{}" : "{}");
                 if (argsObj.filePath) {
                    const ext = argsObj.filePath.split('.').pop();
                    if (ext) lang = ext;
                 }
              } catch (e) {}
            }
            renderedContent = md.render("```" + lang + "\n" + msg.content + "\n```") as string;
          }
        }
        if (msg.thinking) {
          renderedThinking = md.render(msg.thinking) as string;
        }
      } catch (e) {
        if (msg.role !== "tool") {
          renderedContent = msg.content;
        } else {
          try {
             renderedContent = md.render("```plaintext\n" + msg.content + "\n```") as string;
          } catch (e2) {
             renderedContent = msg.content;
          }
        }
        renderedThinking = msg.thinking;
      }
      
      msg.renderedContent = renderedContent;
      msg.renderedThinking = renderedThinking;

      return msg;
    });

    void this.view.webview.postMessage({
      type: "state",
      busy: this.busy,
      busyStartTimeMs: this.busyStartTimeMs,
      modelLabel,
      modelLoading: this.modelLoadInProgress,
      thinkingEnabled: this.thinkingEnabled,
      thinkingSupported: this.modelSupportsThinking,
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

  private async refreshModelThinkingSupport(): Promise<void> {
    if (this.thinkingSupportProbeInFlight) {
      return;
    }

    const settings = this.client.getSettings();
    const model = settings.model?.trim();

    if (!model) {
      let changed = false;
      if (this.modelSupportsThinking) {
        this.modelSupportsThinking = false;
        changed = true;
      }
      if (this.lastThinkingSupportModel !== undefined) {
        this.lastThinkingSupportModel = undefined;
        changed = true;
      }
      if (changed) {
        this.postState();
      }
      return;
    }

    const cachedSupport = this.client.getCachedThinkingSupport(model);
    if (typeof cachedSupport === "boolean") {
      let changed = false;
      if (this.modelSupportsThinking !== cachedSupport) {
        this.modelSupportsThinking = cachedSupport;
        changed = true;
      }
      if (this.lastThinkingSupportModel !== model) {
        this.lastThinkingSupportModel = model;
        changed = true;
      }
      if (changed) {
        this.postState();
      }
      return;
    }

    if (this.lastThinkingSupportModel === model) {
      return;
    }

    this.thinkingSupportProbeInFlight = true;
    const tokenSource = new vscode.CancellationTokenSource();
    let stateChanged = false;
    try {
      const supported = await this.client.detectModelThinkingSupport(tokenSource.token, model);
      if (this.modelSupportsThinking !== supported) {
        this.modelSupportsThinking = supported;
        stateChanged = true;
      }
      if (this.lastThinkingSupportModel !== model) {
        this.lastThinkingSupportModel = model;
        stateChanged = true;
      }
    } catch {
      // Best effort.
    } finally {
      tokenSource.dispose();
      this.thinkingSupportProbeInFlight = false;
      if (stateChanged) {
        this.postState();
      }
    }
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
        const alreadyLoaded = await this.client.isModelLoaded(settings.model, tokenSource.token);
        if (alreadyLoaded) {
          this.previouslyLoadedModel = settings.model;
        } else {
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
