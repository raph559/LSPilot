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
import type { ChatContextBlock, ChatContextUsage, ChatHistoryMessage, ChatImageAttachment, ChatTokenUsage } from "../types";
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
  private pendingContextBlocks: ChatContextBlock[] = [];

  private static readonly maxImageAttachmentsPerTurn = 6;
  private static readonly maxImageSizeBytes = 8 * 1024 * 1024;
  private static readonly maxContextBlocksPerTurn = 6;
  private static readonly maxSelectionContextChars = 12_000;
  private static readonly maxFileContextChars = 18_000;

  public constructor(private readonly client: LMStudioClient, private readonly extensionUri: vscode.Uri) {}

  private estimateDataUrlSizeBytes(dataUrl: string): number {
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex < 0) {
      return dataUrl.length;
    }
    const base64Payload = dataUrl.slice(commaIndex + 1);
    return Math.floor((base64Payload.length * 3) / 4);
  }

  private parseIncomingImageAttachments(rawImages: unknown): ChatImageAttachment[] {
    if (!Array.isArray(rawImages)) {
      return [];
    }

    const attachments: ChatImageAttachment[] = [];
    for (const rawImage of rawImages) {
      if (attachments.length >= LSPilotChatViewProvider.maxImageAttachmentsPerTurn) {
        break;
      }

      if (!rawImage || typeof rawImage !== "object") {
        continue;
      }

      const image = rawImage as {
        id?: unknown;
        name?: unknown;
        mimeType?: unknown;
        dataUrl?: unknown;
        sizeBytes?: unknown;
      };

      const dataUrl = typeof image.dataUrl === "string" ? image.dataUrl : "";
      if (!/^data:image\//i.test(dataUrl)) {
        continue;
      }

      const mimeType = typeof image.mimeType === "string" && image.mimeType.startsWith("image/")
        ? image.mimeType
        : "image/png";
      const sizeBytes = typeof image.sizeBytes === "number" && Number.isFinite(image.sizeBytes) && image.sizeBytes > 0
        ? Math.floor(image.sizeBytes)
        : this.estimateDataUrlSizeBytes(dataUrl);
      if (sizeBytes > LSPilotChatViewProvider.maxImageSizeBytes) {
        continue;
      }

      const safeName = typeof image.name === "string" && image.name.trim().length > 0
        ? path.basename(image.name.trim())
        : "image";
      const safeId = typeof image.id === "string" && image.id.trim().length > 0
        ? image.id.trim()
        : `${Date.now()}-${attachments.length}`;

      attachments.push({
        id: safeId,
        name: safeName,
        mimeType,
        dataUrl,
        sizeBytes
      });
    }

    return attachments;
  }

  private trimContextText(text: string, maxChars: number): { content: string; truncated: boolean } {
    if (text.length <= maxChars) {
      return { content: text, truncated: false };
    }
    return {
      content: `${text.slice(0, maxChars)}\n...[truncated]`,
      truncated: true
    };
  }

  private getDisplayPath(uri: vscode.Uri): string {
    if (uri.scheme === "file") {
      return vscode.workspace.asRelativePath(uri, false);
    }
    return `${uri.scheme}:${uri.path}`;
  }

  private createSelectionContextBlock(editor: vscode.TextEditor): ChatContextBlock | undefined {
    const selection = editor.selection;
    if (selection.isEmpty) {
      return undefined;
    }

    const raw = editor.document.getText(selection).trim();
    if (!raw) {
      return undefined;
    }

    const lineStart = selection.start.line + 1;
    const lineEnd = selection.end.line + 1;
    const displayPath = this.getDisplayPath(editor.document.uri);
    const trimmed = this.trimContextText(raw, LSPilotChatViewProvider.maxSelectionContextChars);

    return {
      id: `selection:${editor.document.uri.toString()}:${lineStart}:${lineEnd}`,
      source: "selection",
      label: `Selection ${path.basename(displayPath)}:${lineStart}-${lineEnd}`,
      content: trimmed.content,
      filePath: displayPath,
      languageId: editor.document.languageId,
      lineStart,
      lineEnd,
      truncated: trimmed.truncated
    };
  }

  private createActiveFileContextBlock(editor: vscode.TextEditor): ChatContextBlock | undefined {
    const document = editor.document;
    const lineCount = document.lineCount;
    if (lineCount === 0) {
      return undefined;
    }

    const cursorLine = editor.selection.active.line;
    const startLine = Math.max(0, cursorLine - 120);
    const endLine = Math.min(lineCount - 1, cursorLine + 120);
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character);
    const raw = document.getText(range).trim();
    if (!raw) {
      return undefined;
    }

    const trimmed = this.trimContextText(raw, LSPilotChatViewProvider.maxFileContextChars);
    const displayPath = this.getDisplayPath(document.uri);

    return {
      id: `active-file:${document.uri.toString()}:${startLine + 1}:${endLine + 1}`,
      source: "activeFile",
      label: `Active file ${path.basename(displayPath)}:${startLine + 1}-${endLine + 1}`,
      content: trimmed.content,
      filePath: displayPath,
      languageId: document.languageId,
      lineStart: startLine + 1,
      lineEnd: endLine + 1,
      truncated: trimmed.truncated
    };
  }

  private createFullFileContextBlock(editor: vscode.TextEditor): ChatContextBlock | undefined {
    const document = editor.document;
    const raw = document.getText().trim();
    if (!raw) {
      return undefined;
    }

    const trimmed = this.trimContextText(raw, LSPilotChatViewProvider.maxFileContextChars);
    const displayPath = this.getDisplayPath(document.uri);

    return {
      id: `file:${document.uri.toString()}`,
      source: "file",
      label: `File ${path.basename(displayPath)}`,
      content: trimmed.content,
      filePath: displayPath,
      languageId: document.languageId,
      lineStart: 1,
      lineEnd: document.lineCount,
      truncated: trimmed.truncated
    };
  }

  private collectAutomaticContextBlocks(): ChatContextBlock[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return [];
    }

    const selectionBlock = this.createSelectionContextBlock(editor);
    if (selectionBlock) {
      return [selectionBlock];
    }

    const fileBlock = this.createActiveFileContextBlock(editor);
    return fileBlock ? [fileBlock] : [];
  }

  private async promptAndAddContext(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a file to attach context.");
      return;
    }

    const candidates: Array<vscode.QuickPickItem & { block: ChatContextBlock }> = [];
    const selectionBlock = this.createSelectionContextBlock(editor);
    if (selectionBlock) {
      candidates.push({
        label: "Selection",
        description: selectionBlock.label,
        detail: selectionBlock.truncated ? "Selection clipped to fit context budget." : undefined,
        block: selectionBlock
      });
    }

    const activeFileBlock = this.createActiveFileContextBlock(editor);
    if (activeFileBlock) {
      candidates.push({
        label: "Active File Excerpt",
        description: activeFileBlock.label,
        detail: activeFileBlock.truncated ? "Excerpt clipped to fit context budget." : undefined,
        block: activeFileBlock
      });
    }

    const fullFileBlock = this.createFullFileContextBlock(editor);
    if (fullFileBlock) {
      candidates.push({
        label: "Whole Active File",
        description: fullFileBlock.label,
        detail: fullFileBlock.truncated ? "File clipped to fit context budget." : undefined,
        block: fullFileBlock
      });
    }

    if (candidates.length === 0) {
      vscode.window.showInformationMessage("No editor text available to attach as context.");
      return;
    }

    const picks = await vscode.window.showQuickPick(candidates, {
      canPickMany: true,
      title: "Add Context To Next Message",
      placeHolder: "Pick context to attach"
    });

    if (!picks || picks.length === 0) {
      return;
    }

    const next = [...this.pendingContextBlocks];
    for (const pick of picks) {
      const existingIndex = next.findIndex((block) => block.id === pick.block.id);
      if (existingIndex >= 0) {
        next[existingIndex] = pick.block;
      } else if (next.length < LSPilotChatViewProvider.maxContextBlocksPerTurn) {
        next.push(pick.block);
      }
    }

    this.pendingContextBlocks = next;
    this.postState();
  }

  private estimateUserPromptChars(message: ChatHistoryMessage): number {
    let total = message.content?.length || 0;
    if (Array.isArray(message.contextBlocks)) {
      for (const block of message.contextBlocks) {
        total += (block.label?.length || 0) + (block.content?.length || 0) + 48;
      }
    }
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      // Vision payloads add non-trivial tokens even without OCR text.
      total += message.attachments.length * 80;
    }
    return total;
  }

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
    this.pendingContextBlocks = [];
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

    const message = rawMessage as {
      type?: string;
      text?: unknown;
      index?: number;
      enableThinking?: unknown;
      enabled?: unknown;
      images?: unknown;
      contextId?: unknown;
    };

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

    if (message.type === "addContext") {
      await this.promptAndAddContext();
      return;
    }

    if (message.type === "removeContext" && typeof message.contextId === "string") {
      const before = this.pendingContextBlocks.length;
      this.pendingContextBlocks = this.pendingContextBlocks.filter((block) => block.id !== message.contextId);
      if (this.pendingContextBlocks.length !== before) {
        this.postState();
      }
      return;
    }

    if (message.type === "clearContext") {
      if (this.pendingContextBlocks.length > 0) {
        this.pendingContextBlocks = [];
        this.postState();
      }
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
      const attachments = this.parseIncomingImageAttachments(message.images);
      await this.sendUserMessage(message.text, shouldEnableThinking, attachments);
    }
  }

  private async sendUserMessage(text: string, enableThinking: boolean, attachments: ChatImageAttachment[] = []): Promise<void> {
    const trimmed = text.trim();
    const manualContext = [...this.pendingContextBlocks];
    const automaticContext = manualContext.length === 0 ? this.collectAutomaticContextBlocks() : [];
    const contextBlocks = (manualContext.length > 0 ? manualContext : automaticContext)
      .slice(0, LSPilotChatViewProvider.maxContextBlocksPerTurn);

    if (!trimmed && attachments.length === 0 && contextBlocks.length === 0) {
      return;
    }

    if (this.busy) {
      vscode.window.showInformationMessage("LSPilot is already generating a response.");
      return;
    }

    this.history.push({
      role: "user",
      content: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      contextBlocks: contextBlocks.length > 0 ? contextBlocks : undefined
    });
    this.pendingContextBlocks = [];
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
      pendingContextBlocks: this.pendingContextBlocks,
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
            extraUserLen = this.estimateUserPromptChars(preMsg);
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
