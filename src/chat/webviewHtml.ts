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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LSPilot Chat</title>
  <link href="${codiconsUri}" rel="stylesheet" />
  <style>
${getWebviewStyles(extensionUri)}
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="model" id="model">Model: None</div>
    <div class="actions">
      <button id="selectModel" class="secondary">Select Model</button>
      <button id="clear" class="secondary">Clear</button>
    </div>
  </div>
  <div id="messages"></div>
  <div class="composer">
    <div id="globalPendingEdits" class="global-pending-edits"></div>
    <div class="context context-in-composer hidden" id="context" title="Context info unavailable. LM Studio did not return runtime context metadata and/or usage.">
      <div class="context-label" id="contextLabel">Context unavailable</div>
      <div class="context-track">
        <div class="context-fill" id="contextFill"></div>
      </div>
    </div>
    <div class="input-wrapper">
      <textarea id="input" placeholder="Ask something about your code..."></textarea>
      <div class="send-row">
        <span class="hint">Enter to send, Shift+Enter for newline</span>
        <div class="button-group">
          <button id="stop" class="hidden">Stop</button>
          <button id="send">Send</button>
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
