import * as vscode from "vscode";
import * as path from "path";
import * as diff from "diff";
import MarkdownIt from "markdown-it";
// @ts-ignore
import markdownItImsize from "markdown-it-imsize";
// @ts-ignore
import markdownItTaskLists from "markdown-it-task-lists";
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
.use(markdownItImsize)
.use(markdownItTaskLists);

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
import {
  toolsDefinition,
  executeTool,
  type ManagedTerminalSnapshot,
  getManagedTerminalSnapshot,
  revealManagedTerminal,
  sendInputToManagedTerminal
} from "./tools";
import { LSPilotDiffProvider } from "./lspilotDiffProvider";

type CommandApprovalRequest = {
  key: string;
  title: string;
  detail: string;
  pendingText: string;
  deniedText: string;
  startText?: string;
};

export class LSPilotChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lspilot.chatView";

  private view: vscode.WebviewView | undefined;
  private mode: "ask" | "plan" | "agent" = "agent";
  private plan: any[] | undefined;
  private history: ChatHistoryMessage[] = [];
  private busy = false;
  private activeRequest: vscode.CancellationTokenSource | undefined;
  private busyStartTimeMs: number | undefined;

  private trimHistory(): void {
    if (this.history.length <= 30) {
      return;
    }

    let sliceIndex = this.history.length - 30;
    while (sliceIndex < this.history.length) {
      if (this.history[sliceIndex].role === 'user') {
        break;
      }
      sliceIndex++;
    }

    if (sliceIndex >= this.history.length) {
      let lastUserIndex = -1;
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }
      sliceIndex = lastUserIndex !== -1 ? lastUserIndex : 0;
    }

    this.history = this.history.slice(sliceIndex);
  }

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
  private activeEmbeddedTerminalId: string | undefined;
  private embeddedTerminalVisible = false;
  private embeddedTerminalPollHandle: NodeJS.Timeout | undefined;
  private embeddedTerminalSnapshot: ManagedTerminalSnapshot | undefined = undefined;
  private allowCommandExecutionForConversation = false;
  private readonly sessionAllowedCommandKeys = new Set<string>();
  private readonly sessionDeniedCommandKeys = new Set<string>();
  private activeCommandApproval?: {
    request: CommandApprovalRequest;
    resolve: (result: { approved: boolean; resultText?: string }) => void;
  };

  private static readonly maxImageAttachmentsPerTurn = 6;
  private static readonly maxImageSizeBytes = 8 * 1024 * 1024;
  private static readonly maxContextBlocksPerTurn = 96;
  private static readonly maxSelectionContextChars = 12_000;
  private static readonly maxFileContextChars = 18_000;
  private static readonly maxWorkspaceFilePickCount = 64;
  private static readonly maxWorkspaceFileSizeBytes = 300 * 1024;
  private static readonly maxCodebaseFileCount = 120;
  private static readonly maxCodebaseCandidateFiles = 3000;
  private static readonly maxCodebasePerFileChars = 3_200;
  private static readonly maxCodebaseTotalChars = 180_000;

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

  private isLikelyIgnoredCodebasePath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
    const segments = normalized.split("/");
    const ignoredDirs = new Set([
      ".git",
      "node_modules",
      "dist",
      "build",
      "out",
      ".next",
      ".nuxt",
      "coverage",
      "target",
      "bin",
      "obj",
      ".venv",
      "venv",
      "__pycache__",
      ".idea",
      ".vscode"
    ]);

    if (segments.some((segment) => ignoredDirs.has(segment))) {
      return true;
    }

    const ignoredSuffixes = [
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".svg",
      ".mp3", ".mp4", ".mkv", ".webm", ".wav", ".ogg", ".flac",
      ".zip", ".tar", ".gz", ".7z", ".rar",
      ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
      ".jar", ".class", ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj",
      ".ttf", ".otf", ".woff", ".woff2", ".eot",
      ".map"
    ];

    if (ignoredSuffixes.some((suffix) => normalized.endsWith(suffix))) {
      return true;
    }

    if (/\.min\.(js|css)$/i.test(normalized)) {
      return true;
    }

    return false;
  }

  private async readWorkspaceTextFileSnippet(
    uri: vscode.Uri,
    maxChars: number,
    maxFileSizeBytes = LSPilotChatViewProvider.maxWorkspaceFileSizeBytes
  ): Promise<{ relativePath: string; languageId: string; content: string; lineCount: number; truncated: boolean } | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) === 0 || stat.size <= 0 || stat.size > maxFileSizeBytes) {
        return undefined;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const raw = document.getText().trim();
      if (!raw || raw.includes("\u0000")) {
        return undefined;
      }

      const trimmed = this.trimContextText(raw, maxChars);
      return {
        relativePath: this.getDisplayPath(uri),
        languageId: document.languageId || "plaintext",
        content: trimmed.content,
        lineCount: document.lineCount,
        truncated: trimmed.truncated
      };
    } catch {
      return undefined;
    }
  }

  private addPendingContextBlocks(blocks: ChatContextBlock[]): void {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return;
    }

    const next = [...this.pendingContextBlocks];
    let dropped = 0;
    let changed = false;

    for (const block of blocks) {
      const existingIndex = next.findIndex((item) => item.id === block.id);
      if (existingIndex >= 0) {
        next[existingIndex] = block;
        changed = true;
        continue;
      }

      if (next.length >= LSPilotChatViewProvider.maxContextBlocksPerTurn) {
        dropped += 1;
        continue;
      }

      next.push(block);
      changed = true;
    }

    if (changed) {
      this.pendingContextBlocks = next;
      this.postState();
    }

    if (dropped > 0) {
      vscode.window.showWarningMessage(
        `LSPilot context limit reached. ${dropped} context block${dropped > 1 ? "s were" : " was"} not added.`
      );
    }
  }

  private async promptForWorkspaceFilesContextBlocks(): Promise<ChatContextBlock[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showInformationMessage("Open a workspace folder to attach files.");
      return [];
    }

    const pickedUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: true,
      canSelectFolders: false,
      openLabel: "Add Files As Context",
      defaultUri: folders[0].uri
    });

    if (!pickedUris || pickedUris.length === 0) {
      return [];
    }

    const limitedUris = pickedUris.slice(0, LSPilotChatViewProvider.maxWorkspaceFilePickCount);
    if (limitedUris.length < pickedUris.length) {
      vscode.window.showInformationMessage(
        `LSPilot: Using first ${limitedUris.length} files (max ${LSPilotChatViewProvider.maxWorkspaceFilePickCount} per add).`
      );
    }

    const blocks: ChatContextBlock[] = [];
    let skipped = 0;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LSPilot: Adding file context",
        cancellable: false
      },
      async (progress) => {
        let index = 0;
        for (const uri of limitedUris) {
          const snippet = await this.readWorkspaceTextFileSnippet(uri, LSPilotChatViewProvider.maxFileContextChars);
          if (snippet) {
            blocks.push({
              id: `file:${uri.toString()}`,
              source: "file",
              label: `File ${snippet.relativePath}`,
              content: snippet.content,
              filePath: snippet.relativePath,
              languageId: snippet.languageId,
              lineStart: 1,
              lineEnd: snippet.lineCount,
              truncated: snippet.truncated
            });
          } else {
            skipped += 1;
          }

          index += 1;
          progress.report({
            increment: 100 / limitedUris.length,
            message: `${index}/${limitedUris.length}`
          });
        }
      }
    );

    if (skipped > 0) {
      vscode.window.showInformationMessage(
        `LSPilot skipped ${skipped} file${skipped > 1 ? "s" : ""} (non-text, empty, too large, or unreadable).`
      );
    }

    return blocks;
  }

  private async buildCodebaseContextBlock(): Promise<ChatContextBlock | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showInformationMessage("Open a workspace folder to attach codebase context.");
      return undefined;
    }

    const perFolderLimit = Math.max(1, Math.ceil(LSPilotChatViewProvider.maxCodebaseCandidateFiles / folders.length));
    const foundUris: vscode.Uri[] = [];
    const excludeGlob =
      "**/{.git,node_modules,dist,build,out,.next,.nuxt,coverage,target,bin,obj,.venv,venv,__pycache__,.idea,.vscode}/**";

    for (const folder of folders) {
      const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*"),
        excludeGlob,
        perFolderLimit
      );
      foundUris.push(...matches);
    }

    if (foundUris.length === 0) {
      return undefined;
    }

    const uniqueUris = [...new Map(foundUris.map((uri) => [uri.toString(), uri])).values()]
      .sort((a, b) => this.getDisplayPath(a).localeCompare(this.getDisplayPath(b)));

    const sections: string[] = [];
    let included = 0;
    let scanned = 0;
    let skippedIgnored = 0;
    let skippedUnreadable = 0;
    let aggregateChars = 0;
    let budgetLimited = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LSPilot: Building whole codebase context",
        cancellable: false
      },
      async (progress) => {
        const total = Math.max(1, uniqueUris.length);

        for (const uri of uniqueUris) {
          if (included >= LSPilotChatViewProvider.maxCodebaseFileCount) {
            budgetLimited = true;
            break;
          }

          const relativePath = this.getDisplayPath(uri);
          if (this.isLikelyIgnoredCodebasePath(relativePath)) {
            skippedIgnored += 1;
            scanned += 1;
            continue;
          }

          const snippet = await this.readWorkspaceTextFileSnippet(
            uri,
            LSPilotChatViewProvider.maxCodebasePerFileChars
          );
          scanned += 1;

          if (!snippet) {
            skippedUnreadable += 1;
            continue;
          }

          const header =
            `[FILE] ${snippet.relativePath} | language=${snippet.languageId} | lines=1-${snippet.lineCount}` +
            (snippet.truncated ? " | truncated=true" : "");
          const section = `${header}\n${snippet.content}`;

          if (aggregateChars + section.length + 2 > LSPilotChatViewProvider.maxCodebaseTotalChars) {
            budgetLimited = true;
            break;
          }

          sections.push(section);
          aggregateChars += section.length + 2;
          included += 1;

          if (scanned % 20 === 0) {
            progress.report({
              increment: (20 / total) * 100,
              message: `${Math.min(scanned, uniqueUris.length)}/${uniqueUris.length} files scanned`
            });
          }
        }

        progress.report({ increment: 100 });
      }
    );

    if (sections.length === 0) {
      return undefined;
    }

    const roots = folders.map((folder) => vscode.workspace.asRelativePath(folder.uri, false)).join(", ");
    const summaryLines = [
      `Workspace roots: ${roots}`,
      `Included files: ${included}`,
      `Scanned candidates: ${Math.min(scanned, uniqueUris.length)} / ${uniqueUris.length}`,
      `Skipped ignored paths: ${skippedIgnored}`,
      `Skipped unreadable/non-text/oversize: ${skippedUnreadable}`,
      `Budget limited: ${budgetLimited ? "true" : "false"}`
    ];
    const content = `${summaryLines.join("\n")}\n\n${sections.join("\n\n-----\n\n")}`;
    const final = this.trimContextText(content, LSPilotChatViewProvider.maxCodebaseTotalChars);
    const workspaceKey = folders.map((folder) => folder.uri.toString()).sort().join("|");

    return {
      id: `codebase:${workspaceKey}`,
      source: "codebase",
      label: `Whole Codebase (${included} files)`,
      content: final.content,
      filePath: roots,
      truncated: final.truncated || budgetLimited
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

    return [];
  }

  private async promptAndAddContext(): Promise<void> {
    type ContextAction = "selection" | "activeExcerpt" | "activeFile" | "workspaceFiles" | "codebase";
    const editor = vscode.window.activeTextEditor;
    const items: Array<vscode.QuickPickItem & { action: ContextAction }> = [];

    if (editor) {
      const selection = this.createSelectionContextBlock(editor);
      if (selection) {
        items.push({
          label: "Selection",
          description: selection.label,
          detail: selection.truncated ? "Selection clipped to fit context budget." : "Attach selected text from active editor.",
          action: "selection"
        });
      }

      const excerpt = this.createActiveFileContextBlock(editor);
      if (excerpt) {
        items.push({
          label: "Active File Excerpt",
          description: excerpt.label,
          detail: excerpt.truncated ? "Excerpt clipped to fit context budget." : "Attach nearby lines around cursor.",
          action: "activeExcerpt"
        });
      }

      const whole = this.createFullFileContextBlock(editor);
      if (whole) {
        items.push({
          label: "Whole Active File",
          description: whole.label,
          detail: whole.truncated ? "File clipped to fit context budget." : "Attach full active file contents.",
          action: "activeFile"
        });
      }
    }

    items.push({
      label: "Workspace Files...",
      description: "Pick one or more files from your workspace",
      detail: "Supports multi-select; files are clipped if too large.",
      action: "workspaceFiles"
    });
    items.push({
      label: "Whole Codebase Snapshot",
      description: "Attach a bounded snapshot of many files in workspace",
      detail: "Automatically skips generated/binary files and applies size limits.",
      action: "codebase"
    });

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: false,
      title: "Add Context To Next Message",
      placeHolder: "Choose what context to add"
    });
    if (!picked) {
      return;
    }

    if (picked.action === "selection" && editor) {
      const block = this.createSelectionContextBlock(editor);
      if (block) {
        this.addPendingContextBlocks([block]);
      }
      return;
    }
    if (picked.action === "activeExcerpt" && editor) {
      const block = this.createActiveFileContextBlock(editor);
      if (block) {
        this.addPendingContextBlocks([block]);
      }
      return;
    }
    if (picked.action === "activeFile" && editor) {
      const block = this.createFullFileContextBlock(editor);
      if (block) {
        this.addPendingContextBlocks([block]);
      }
      return;
    }
    if (picked.action === "workspaceFiles") {
      const blocks = await this.promptForWorkspaceFilesContextBlocks();
      this.addPendingContextBlocks(blocks);
      return;
    }
    if (picked.action === "codebase") {
      const block = await this.buildCodebaseContextBlock();
      if (block) {
        this.addPendingContextBlocks([block]);
      } else {
        vscode.window.showInformationMessage("LSPilot could not build a codebase context block from this workspace.");
      }
    }
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

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private parseToolArgs(argsString: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(argsString) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private isCommandExecutionTool(toolName: string): boolean {
    return toolName === "runCommand" || toolName === "runInTerminal" || toolName === "sendTerminalInput";
  }

  private resolveCommandPath(value: string): string {
    const normalized = value.trim();
    if (!normalized) {
      return normalized;
    }
    if (path.isAbsolute(normalized)) {
      return path.normalize(normalized);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      return path.normalize(path.join(workspaceRoot, normalized));
    }

    return path.normalize(path.join(process.cwd(), normalized));
  }

  private getDefaultCommandWorkingDirectory(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  private buildCommandApprovalRequest(toolName: string, argsString: string): CommandApprovalRequest | undefined {
    const argsObj = this.parseToolArgs(argsString);
    const rawArgsDetail = argsString.trim();

    if (toolName === "sendTerminalInput") {
      const terminalId = typeof argsObj?.id === "string" ? argsObj.id.trim() : "";
      const text = typeof argsObj?.text === "string" ? argsObj.text : "";
      const detailLines = [
        "Tool: sendTerminalInput",
        terminalId ? `Terminal: ${terminalId}` : "Terminal: (not specified)",
        text ? `Input:\n${text}` : rawArgsDetail ? `Arguments:\n${rawArgsDetail}` : "Input: (unavailable)"
      ];

      return {
        key: JSON.stringify({ toolName, terminalId, text }),
        title: "LSPilot wants to send terminal input.",
        detail: detailLines.join("\n"),
        pendingText: "[Waiting for permission to send terminal input...]",
        deniedText: "Terminal input was not sent because the user denied permission."
      };
    }

    if (toolName !== "runCommand" && toolName !== "runInTerminal") {
      return undefined;
    }

    const command = typeof argsObj?.command === "string" ? argsObj.command : "";
    const cwd = typeof argsObj?.cwd === "string" && argsObj.cwd.trim().length > 0
      ? this.resolveCommandPath(argsObj.cwd)
      : this.getDefaultCommandWorkingDirectory();
    const timeoutMs = typeof argsObj?.timeoutMs === "number" && Number.isFinite(argsObj.timeoutMs)
      ? Math.max(0, Math.floor(argsObj.timeoutMs))
      : toolName === "runCommand"
        ? 60_000
        : 60_000;
    const terminalId = typeof argsObj?.id === "string" ? argsObj.id.trim() : "";
    const isBackground = toolName === "runInTerminal" && argsObj?.isBackground === true;
    const detailLines = [
      `Tool: ${toolName}`,
      command ? `Command: ${command}` : rawArgsDetail ? `Arguments:\n${rawArgsDetail}` : "Command: (unavailable)",
      `Working directory: ${cwd}`
    ];

    if (toolName === "runInTerminal") {
      detailLines.push(`Terminal: ${terminalId || "(new terminal)"}`);
      detailLines.push(`Background: ${isBackground ? "yes" : "no"}`);
    }

    return {
      key: JSON.stringify({ toolName, command, cwd, timeoutMs, terminalId, isBackground }),
      title: "LSPilot wants to run a command.",
      detail: detailLines.join("\n"),
      pendingText: "[Waiting for permission to run command...]",
      deniedText: "Command execution was denied by the user.",
      startText: "[Starting terminal command...]"
    };
  }

  private async requestCommandApproval(
    request: CommandApprovalRequest,
    token: vscode.CancellationToken
  ): Promise<{ approved: boolean; resultText?: string }> {
    if (this.allowCommandExecutionForConversation || this.sessionAllowedCommandKeys.has(request.key)) {
      return { approved: true };
    }

    if (this.sessionDeniedCommandKeys.has(request.key)) {
      return { approved: false, resultText: request.deniedText };
    }

    return new Promise((resolve) => {
      let resolved = false;

      const finish = (result: { approved: boolean; resultText?: string }) => {
        if (!resolved) {
          resolved = true;
          this.activeCommandApproval = undefined;
          this.postState();
          resolve(result);
        }
      };

      const disposable = token.onCancellationRequested(() => {
        disposable.dispose();
        finish({
          approved: false,
          resultText: "Command execution was cancelled before approval completed."
        });
      });

      this.activeCommandApproval = {
        request,
        resolve: (result) => {
          disposable.dispose();
          finish(result);
        }
      };

      this.postState();
    });
  }

  private buildToolMeta(toolName: string, argsString: string): ChatHistoryMessage["toolMeta"] | undefined {
    const argsObj = this.parseToolArgs(argsString);
    if (!argsObj) {
      return undefined;
    }

    switch (toolName) {
      case "runCommand":
      case "runInTerminal":
        return {
          command: typeof argsObj.command === "string" ? argsObj.command : undefined,
          cwd: typeof argsObj.cwd === "string" ? argsObj.cwd : undefined,
          timeoutMs: typeof argsObj.timeoutMs === "number" ? argsObj.timeoutMs : undefined,
          terminalId: typeof argsObj.id === "string" ? argsObj.id : undefined
        };
      case "readTerminal":
      case "sendTerminalInput":
        return {
          terminalId: typeof argsObj.id === "string" ? argsObj.id : undefined
        };
      default:
        return undefined;
    }
  }

  private buildToolSummary(toolName: string, argsString: string): string {
    let summaryInfo = toolName;
    const argsObj = this.parseToolArgs(argsString);
    if (!argsObj) {
      return summaryInfo;
    }

    const shortText = (value: unknown, maxLength = 48): string => {
      const raw = typeof value === "string" ? value.trim() : "";
      if (!raw) {
        return "";
      }
      return raw.length > maxLength ? `${raw.substring(0, maxLength)}...` : raw;
    };
    const leafName = (value: unknown, fallback = ""): string => {
      const raw = typeof value === "string" ? value.trim() : "";
      if (!raw) {
        return fallback;
      }
      return path.basename(raw) || raw;
    };

    switch (toolName) {
      case "writeFile":
      case "appendFile":
      case "replaceInFile":
      case "readFile":
      case "readFileRange": {
        const rawPath = typeof argsObj.filePath === "string" ? argsObj.filePath : "";
        const file = leafName(rawPath);
        if (file) {
          summaryInfo += ` on <b>${this.escapeHtml(file)}</b>`;
        }
        break;
      }
      case "pathExists":
      case "fileStats":
      case "deletePath": {
        const rawPath = typeof argsObj.targetPath === "string" ? argsObj.targetPath : "";
        const file = leafName(rawPath);
        if (file) {
          summaryInfo += ` on <b>${this.escapeHtml(file)}</b>`;
        }
        break;
      }
      case "listDirectory":
      case "createDirectory": {
        const rawDir = typeof argsObj.dirPath === "string" ? argsObj.dirPath : "";
        const dir = leafName(rawDir, "/");
        summaryInfo += ` in <b>${this.escapeHtml(dir || "/")}</b>`;
        break;
      }
      case "runCommand":
      case "runInTerminal": {
        const id = shortText(argsObj.id, 24);
        const cmd = shortText(argsObj.command, 64);
        if (id) {
          summaryInfo += ` in <code>${this.escapeHtml(id)}</code>`;
        }
        if (cmd) {
          summaryInfo += ` <code>${this.escapeHtml(cmd)}</code>`;
        }
        break;
      }
      case "readTerminal": {
        const id = shortText(argsObj.id, 24);
        if (id) {
          summaryInfo += ` (Terminal <code>${this.escapeHtml(id)}</code>)`;
        }
        break;
      }
      case "sendTerminalInput": {
        const id = shortText(argsObj.id, 24);
        const txt = shortText(argsObj.text, 32);
        if (id && txt) {
          summaryInfo += ` to <code>${this.escapeHtml(id)}</code>: <code>${this.escapeHtml(txt)}</code>`;
        } else if (id) {
          summaryInfo += ` to <code>${this.escapeHtml(id)}</code>`;
        }
        break;
      }
      case "findFiles": {
        const pattern = shortText(argsObj.globPattern);
        if (pattern) {
          summaryInfo += ` <code>${this.escapeHtml(pattern)}</code>`;
        }
        break;
      }
      case "searchInFiles": {
        const query = shortText(argsObj.query);
        if (query) {
          summaryInfo += ` for <code>${this.escapeHtml(query)}</code>`;
        }
        break;
      }
      case "renamePath": {
        const from = leafName(argsObj.oldPath, "source");
        const to = leafName(argsObj.newPath, "target");
        summaryInfo += ` <code>${this.escapeHtml(from)}</code> -> <code>${this.escapeHtml(to)}</code>`;
        break;
      }
      case "copyPath": {
        const from = leafName(argsObj.sourcePath, "source");
        const to = leafName(argsObj.destinationPath, "target");
        summaryInfo += ` <code>${this.escapeHtml(from)}</code> -> <code>${this.escapeHtml(to)}</code>`;
        break;
      }
      default:
        break;
    }

    return summaryInfo;
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
      this.stopEmbeddedTerminalPolling();
    });

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    this.syncEmbeddedTerminalPolling();
    this.postState();
  }

  public refresh(): void {
    this.detectedContextWindowTokens = undefined;
    this.lastThinkingSupportModel = undefined;
    this.client.resetReasoningOffSession();
    this.postState();
  }

  public clearChat(showNotification = false): void {
    this.activeRequest?.cancel();
    this.activeRequest?.dispose();
    this.activeRequest = undefined;
    this.busyStartTimeMs = undefined;
    this.busy = false;
    this.plan = undefined;
    this.history = [];
    this.pendingContextBlocks = [];
    this.lastTokenUsage = undefined;
    this.activeEmbeddedTerminalId = undefined;
    this.embeddedTerminalVisible = false;
    this.embeddedTerminalSnapshot = undefined;
    this.allowCommandExecutionForConversation = false;
    this.sessionAllowedCommandKeys.clear();
    this.sessionDeniedCommandKeys.clear();
    this.stopEmbeddedTerminalPolling();
    this.client.resetReasoningOffSession();
    this.postState();

    if (showNotification) {
      vscode.window.showInformationMessage("LSPilot chat cleared.");
    }
  }

  private setActiveEmbeddedTerminal(id: string | undefined): void {
    this.activeEmbeddedTerminalId = id;
    this.embeddedTerminalVisible = Boolean(id);
    this.embeddedTerminalSnapshot = id ? getManagedTerminalSnapshot(id) : undefined;
    this.syncEmbeddedTerminalPolling();
    this.postState();
  }

  private hideEmbeddedTerminal(): void {
    if (!this.activeEmbeddedTerminalId) {
      return;
    }

    this.embeddedTerminalVisible = false;
    this.postState();
  }

  private restoreEmbeddedTerminal(): void {
    if (!this.activeEmbeddedTerminalId) {
      return;
    }

    this.embeddedTerminalVisible = true;
    this.refreshEmbeddedTerminalSnapshot();
    this.postState();
  }

  private stopEmbeddedTerminalPolling(): void {
    if (this.embeddedTerminalPollHandle) {
      clearInterval(this.embeddedTerminalPollHandle);
      this.embeddedTerminalPollHandle = undefined;
    }
  }

  private syncEmbeddedTerminalPolling(): void {
    this.stopEmbeddedTerminalPolling();
    if (!this.view || !this.activeEmbeddedTerminalId) {
      return;
    }

    this.embeddedTerminalPollHandle = setInterval(() => {
      this.refreshEmbeddedTerminalSnapshot();
    }, 250);
  }

  private refreshEmbeddedTerminalSnapshot(): void {
    if (!this.view || !this.activeEmbeddedTerminalId) {
      return;
    }

    const snapshot = getManagedTerminalSnapshot(this.activeEmbeddedTerminalId);
    if (!snapshot) {
      this.activeEmbeddedTerminalId = undefined;
      this.embeddedTerminalVisible = false;
      this.embeddedTerminalSnapshot = undefined;
      this.stopEmbeddedTerminalPolling();
      void this.view.webview.postMessage({ type: "terminalState", terminal: undefined, visible: false });
      return;
    }

    const nextSerialized = JSON.stringify(snapshot);
    const previousSerialized = this.embeddedTerminalSnapshot ? JSON.stringify(this.embeddedTerminalSnapshot) : "";
    if (nextSerialized === previousSerialized) {
      return;
    }

    this.embeddedTerminalSnapshot = snapshot;
    void this.view.webview.postMessage({ type: "terminalState", terminal: snapshot, visible: this.embeddedTerminalVisible });
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
      terminalId?: unknown;
      choice?: unknown;
    };

    if (message.type === "changeMode" && typeof (message as any).mode === "string") {
      this.mode = (message as any).mode as "ask" | "plan" | "agent";
      this.postState();
      return;
    }

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

    if (message.type === "approveCommand" && typeof message.choice === "string" && this.activeCommandApproval) {
      if (message.choice === "alwaysThisChat") {
        this.allowCommandExecutionForConversation = true;
        this.activeCommandApproval.resolve({ approved: true });
      } else if (message.choice === "alwaysThisCommand") {
        this.sessionAllowedCommandKeys.add(this.activeCommandApproval.request.key);
        this.activeCommandApproval.resolve({ approved: true });
      } else if (message.choice === "allow") {
        this.activeCommandApproval.resolve({ approved: true });
      } else {
        // Explicitly denying adds it to the deny list for the session just like the prompt entails.
        this.sessionDeniedCommandKeys.add(this.activeCommandApproval.request.key);
        this.activeCommandApproval.resolve({ 
          approved: false, 
          resultText: this.activeCommandApproval.request.deniedText 
        });
      }
      return;
    }

    if (message.type === "clear") {
      this.clearChat();
      return;
    }

    if (message.type === "hideTerminal") {
      this.hideEmbeddedTerminal();
      return;
    }

    if (message.type === "restoreTerminal") {
      this.restoreEmbeddedTerminal();
      return;
    }

    if (message.type === "showTerminal" && typeof message.terminalId === "string") {
      if (!revealManagedTerminal(message.terminalId)) {
        vscode.window.showErrorMessage(`Terminal ${message.terminalId} is no longer available.`);
      }
      return;
    }

    if (message.type === "terminalInput" && typeof message.terminalId === "string" && typeof message.text === "string") {
      const result = sendInputToManagedTerminal(message.terminalId, message.text);
      if (!result.ok) {
        vscode.window.showErrorMessage(result.message);
      } else {
        this.setActiveEmbeddedTerminal(message.terminalId);
        this.refreshEmbeddedTerminalSnapshot();
      }
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
    this.trimHistory();

    const startTimeMs = Date.now();
    this.busyStartTimeMs = startTimeMs;
    this.busy = true;

    const tokenSource = new vscode.CancellationTokenSource();
    this.activeRequest = tokenSource;

    try {
      let runNext = true;
      while (runNext && !tokenSource.token.isCancellationRequested) {
        runNext = false;
        
          let toolsToUse: any[] | undefined = undefined;
          let systemPromptOverride: string | undefined = undefined;
          if (this.mode === "ask") {
            const readOnlyTools = ["readFile", "readFileRange", "listDirectory", "pathExists", "fileStats", "findFiles", "searchInFiles"];
            toolsToUse = toolsDefinition.filter((t: any) => readOnlyTools.includes(t.function.name));
            systemPromptOverride = "You are in ASK mode. Answer the user's questions. You can use tools to read code if needed, but you must not attempt to modify any files or execute commands. The user is asking a question.";
          } else if (this.mode === "plan") {
            const readOnlyTools = ["readFile", "readFileRange", "listDirectory", "pathExists", "fileStats", "findFiles", "searchInFiles"];
            toolsToUse = toolsDefinition.filter((t: any) => readOnlyTools.includes(t.function.name));
            toolsToUse.push({ type: "function", function: { name: "setPlan", description: "Save the step-by-step plan you created for the user. Call this tool with a structured list of tasks.", parameters: { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { id: { type: "number" }, title: { type: "string", description: "VERY concise title for the GUI (2-5 words)." }, description: { type: "string", description: "Detailed instructions the agent will need to complete this task." }, status: { type: "string", enum: ["todo", "in-progress", "done"], description: "Current status (MUST be 'todo' when creating the plan)." } }, required: ["id", "title", "description", "status"] } } }, required: ["tasks"] } } });
            systemPromptOverride = "You are in PLAN mode. Analyze the request and figure out a step-by-step plan. You are not allowed to make edits directly. You MUST call the 'setPlan' tool with a JSON array of tasks so the plan is saved for the agent phase. All tasks MUST initially have the status 'todo'. Once you have called the 'setPlan' tool, you MUST stop and wait for the user to switch to AGENT mode. DO NOT execute any plan steps.";
          } else if (this.mode === "agent") {
            toolsToUse = [...toolsDefinition];
              if (this.plan) {
                toolsToUse.push({ type: 'function', function: { name: 'updatePlan', description: 'Update the current step-by-step plan you are working on. Call this tool whenever you complete a task or change its status.', parameters: { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { id: { type: "number" }, title: { type: "string" }, description: { type: "string" }, status: { type: "string", enum: ["todo", "in-progress", "done"] } }, required: ["id", "title", "description", "status"] } } }, required: ["tasks"] } } });
              }
            if (this.plan) {
              systemPromptOverride = "You are in AGENT mode. The following plan has been made by the user. Try to follow it and implement the steps:\n\n" + JSON.stringify(this.plan, null, 2) + "\n\nCRITICAL: You MUST use the `updatePlan` tool to update the task status to 'in-progress' before starting work on a step, and to 'done' after completing it. Always supply the full list of tasks when updating.";
            }
          }

        const requestHistory = [...this.history];
        if (this.mode === "plan" && this.history.length > 0) {
            // Strip out history where the user asked to "follow the plan" but we were in PLAN mode
            const lastMsg = this.history[this.history.length - 1];
            if (lastMsg.role === "user" && lastMsg.content.toLowerCase().includes("follow the plan")) {
               // DO not strip for now, let's fix the user error.
            }
        }
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
        }, toolsToUse, { enableThinking, systemPromptOverride });

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
            const summaryInfo = this.buildToolSummary(tc.function.name, tc.function.arguments);
            const toolMeta = this.buildToolMeta(tc.function.name, tc.function.arguments);
            const approvalRequest = this.isCommandExecutionTool(tc.function.name)
              ? this.buildCommandApprovalRequest(tc.function.name, tc.function.arguments)
              : undefined;
            const toolMessage: ChatHistoryMessage = {
              role: "tool",
              name: tc.function.name,
              toolSummary: summaryInfo,
              tool_call_id: tc.id,
              toolMeta,
              content: approvalRequest?.pendingText ?? (
                tc.function.name === "runCommand" || tc.function.name === "runInTerminal"
                ? "[Starting terminal command...]"
                : ""
              )
            };

            this.history.push(toolMessage);
            this.trimHistory();
            this.postState();

            if (approvalRequest) {
              const approval = await this.requestCommandApproval(approvalRequest, tokenSource.token);
              if (!approval.approved) {
                toolMessage.content = approval.resultText || approvalRequest.deniedText;
                toolMessage.renderedContent = undefined;
                this.postState();

                if (tokenSource.token.isCancellationRequested) {
                  runNext = false;
                  break;
                }
                continue;
              }

              if (approvalRequest.startText) {
                toolMessage.content = approvalRequest.startText;
                toolMessage.renderedContent = undefined;
                this.postState();
              }
            }

            let toolResult;
            if (tc.function.name === "setPlan" || tc.function.name === "updatePlan") {
              try {
                const args = JSON.parse(tc.function.arguments);
                if (tc.function.name === "setPlan") {
                  args.tasks.forEach((t: any) => { t.status = "todo"; });
                  this.plan = args.tasks;
                } else if (tc.function.name === "updatePlan" && this.plan) {
                  args.tasks.forEach((t: any) => {
                    const existing = this.plan!.find((p: any) => p.id === t.id);
                    if (existing) {
                      if (t.status) existing.status = t.status;
                      if (t.title) existing.title = t.title;
                      if (t.description) existing.description = t.description;
                    } else {
                      this.plan!.push(t);
                    }
                  });
                } else if (tc.function.name === "updatePlan") {
                  this.plan = args.tasks;
                }
                toolResult = { text: "Plan successfully saved and displayed." };
                this.postState();
              } catch (e) {
                toolResult = { text: "Failed to parse arguments" };
              }
            } else {
            toolResult = await executeTool(tc.function.name, tc.function.arguments, {
              onUpdate: (text) => {
                if (this.activeRequest !== tokenSource || tokenSource.token.isCancellationRequested) {
                  return;
                }
                toolMessage.content = text;
                toolMessage.renderedContent = undefined;
                this.postState();
              },
              onTerminalSession: (terminalSession) => {
                if (this.activeRequest !== tokenSource || tokenSource.token.isCancellationRequested) {
                  return;
                }
                this.setActiveEmbeddedTerminal(terminalSession.id);
                this.refreshEmbeddedTerminalSnapshot();
              }
              });
            }

            this.coalescePendingFileEdit(toolResult.fileEdit);

            toolMessage.content = toolResult.text;
            toolMessage.fileEdit = toolResult.fileEdit;
            toolMessage.resolvedPath = toolResult.resolvedPath;
            toolMessage.renderedContent = undefined;

            if (tokenSource.token.isCancellationRequested) {
              runNext = false;
              break;
            }
          }
          this.trimHistory();
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
      this.trimHistory();
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

      this.trimHistory();
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
            else if (
              msg.name === "writeFile" ||
              msg.name === "appendFile" ||
              msg.name === "replaceInFile" ||
              msg.name === "readFile" ||
              msg.name === "readFileRange"
            ) {
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
      mode: this.mode,
      plan: this.plan,
      modelLabel,
      modelLoading: this.modelLoadInProgress,
      thinkingEnabled: this.thinkingEnabled,
      thinkingSupported: this.modelSupportsThinking,
      messages: renderedMessages,
      pendingContextBlocks: this.pendingContextBlocks,
      contextUsage,
      embeddedTerminal: this.embeddedTerminalSnapshot,
      embeddedTerminalVisible: this.embeddedTerminalVisible,
      activeCommandApproval: this.activeCommandApproval?.request
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
