import * as vscode from "vscode";
import { chatWebviewScript } from "./webviewScript";
import { chatWebviewStyles } from "./webviewStyles";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export function createChatWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LSPilot Chat</title>
  <style>
${chatWebviewStyles}
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
    <div class="context context-in-composer" id="context" title="Context info unavailable. LM Studio did not return runtime context metadata and/or usage.">
      <div class="context-label" id="contextLabel">Context unavailable</div>
      <div class="context-track">
        <div class="context-fill" id="contextFill"></div>
      </div>
    </div>
    <textarea id="input" placeholder="Ask something about your code..."></textarea>
    <div class="send-row">
      <span class="hint">Enter to send, Shift+Enter for newline</span>
      <button id="send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
${chatWebviewScript}
  </script>
</body>
</html>`;
}
