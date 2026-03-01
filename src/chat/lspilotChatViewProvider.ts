import * as vscode from "vscode";
import { LMStudioClient } from "../client/lmStudioClient";
import type { ChatHistoryMessage } from "../types";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

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

    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

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
    this.busy = true;
    this.postState();

    const tokenSource = new vscode.CancellationTokenSource();
    this.activeRequest = tokenSource;

    try {
      const result = await this.client.generateChatResponse(this.history, tokenSource.token);
      this.history.push({
        role: "assistant",
        content: result.response || "(empty response)"
      });
      this.history = this.history.slice(-30);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.history.push({
        role: "assistant",
        content: `Error: ${message}`
      });
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

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LSPilot Chat</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --border: var(--vscode-panel-border);
      --user-bg: color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent);
      --assistant-bg: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background: var(--bg);
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    .model {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .actions {
      display: flex;
      gap: 6px;
    }
    button {
      border: none;
      background: var(--btn-bg);
      color: var(--btn-fg);
      padding: 5px 9px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 12px;
    }
    button:hover { background: var(--btn-hover); }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .msg {
      border-radius: 8px;
      padding: 8px 10px;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid var(--border);
    }
    .msg.user { background: var(--user-bg); }
    .msg.assistant { background: var(--assistant-bg); }
    .role {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .composer {
      border-top: 1px solid var(--border);
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 72px;
      max-height: 220px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      line-height: 1.4;
    }
    .hint {
      color: var(--muted);
      font-size: 11px;
    }
    .send-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="model" id="model">Model: None</div>
    <div class="actions">
      <button id="selectModel">Select Model</button>
      <button id="clear">Clear</button>
    </div>
  </div>
  <div id="messages"></div>
  <div class="composer">
    <textarea id="input" placeholder="Ask something about your code..."></textarea>
    <div class="send-row">
      <span class="hint">Enter to send, Shift+Enter for newline</span>
      <button id="send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");
    const clearBtn = document.getElementById("clear");
    const selectModelBtn = document.getElementById("selectModel");
    const modelEl = document.getElementById("model");

    let state = { busy: false, modelLabel: "None", messages: [] };

    function appendMessage(message) {
      const wrapper = document.createElement("div");
      wrapper.className = "msg " + message.role;

      const role = document.createElement("div");
      role.className = "role";
      role.textContent = message.role;
      wrapper.appendChild(role);

      const content = document.createElement("div");
      content.textContent = message.content;
      wrapper.appendChild(content);

      messagesEl.appendChild(wrapper);
    }

    function render() {
      modelEl.textContent = "Model: " + state.modelLabel;
      sendBtn.disabled = state.busy;
      inputEl.disabled = state.busy;
      messagesEl.textContent = "";

      for (const message of state.messages) {
        appendMessage(message);
      }

      if (state.busy) {
        appendMessage({ role: "assistant", content: "Thinking..." });
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function sendInput() {
      const text = inputEl.value.trim();
      if (!text || state.busy) {
        return;
      }

      inputEl.value = "";
      vscode.postMessage({ type: "send", text });
    }

    sendBtn.addEventListener("click", sendInput);
    clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    selectModelBtn.addEventListener("click", () => vscode.postMessage({ type: "selectModel" }));
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendInput();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "state") {
        state = message;
        render();
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
