import * as vscode from "vscode";
import { chatWebviewScript } from "./webviewScript";
import { getWebviewStyles } from "./webviewStyles";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export function createChatWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LSPilot Chat</title>
  <link href="${codiconsUri}" rel="stylesheet" />
  <style>
${getWebviewStyles(extensionUri)}
  </style>
</head>
<body>
  <div class="toolbar">
    <div style="display: flex; gap: 8px; align-items: center;">
      <select id="chatMode" class="dropdown" title="Select Mode">
        <option value="ask">Ask</option>
        <option value="plan">Plan</option>
        <option value="agent" selected>Agent</option>
      </select>
      <div class="model" id="model">Model: None</div>
    </div>
    <div class="actions">
      <button id="selectModel" class="secondary icon-only" title="Select Model"><i class="codicon codicon-hubot"></i></button>
      <button id="clear" class="secondary icon-only" title="New Chat"><i class="codicon codicon-add"></i></button>
    </div>
  </div>
  <div id="planContainer" class="plan-container hidden"></div>
  <div id="messages"></div>
  <div id="commandApprovalHost" class="command-approval-host hidden"></div>
  <div id="embeddedTerminalHost" class="embedded-terminal-host hidden"></div>
  <div class="composer">
    <div id="globalPendingEdits" class="global-pending-edits"></div>
    <div class="context context-in-composer hidden" id="context" title="Context info unavailable. LM Studio did not return runtime context metadata and/or usage.">
      <div class="context-label" id="contextLabel">Context unavailable</div>
      <div class="context-track">
        <div class="context-fill" id="contextFill"></div>
      </div>
    </div>
    <div class="input-wrapper">
      <div class="attachments-area">
        <div id="contextChips" class="context-chips hidden"></div>
        <div id="imagePreview" class="image-preview hidden"></div>
      </div>
      <textarea id="input" rows="1" placeholder="Ask something about your code..."></textarea>
      <input id="imageInput" type="file" accept="image/*" multiple style="display:none;" />
      <div class="send-row">
        <div class="button-group left-actions">
          <button id="addContext" class="icon-toggle" title="Add code context to next message" aria-label="Add context">
            <i class="codicon codicon-symbol-field"></i>
          </button>
          <button id="attachImage" class="icon-toggle" title="Attach image(s)" aria-label="Attach image">
            <i class="codicon codicon-device-camera"></i>
          </button>
          <button id="thinkingToggle" class="icon-toggle" title="Enable deep thinking" aria-label="Toggle deep thinking">
            <i class="codicon codicon-lightbulb"></i>
          </button>
        </div>
        <div class="button-group right-actions">
          <button id="stop" class="icon-toggle stop-btn hidden" title="Stop generating" aria-label="Stop"><i class="codicon codicon-debug-stop"></i></button>
          <button id="send" class="icon-toggle send-btn" title="Send" aria-label="Send"><i class="codicon codicon-send"></i></button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
${chatWebviewScript}
  </script>
</body>
</html>`;
}
