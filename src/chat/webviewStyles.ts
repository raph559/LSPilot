export const chatWebviewStyles = `
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
      min-width: 0;
    }
    .context {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 110px;
      max-width: 190px;
      width: 100%;
    }
    .context.hidden {
      display: none;
    }
    .context-in-composer {
      max-width: none;
      min-width: 0;
    }
    .context-label {
      color: var(--muted);
      font-size: 11px;
      line-height: 1;
    }
    .context-track {
      width: 100%;
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-input-background) 75%, var(--bg));
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    }
    .context-fill {
      width: 0%;
      height: 100%;
      background: linear-gradient(
        90deg,
        var(--vscode-charts-green, #4caf50) 0%,
        var(--vscode-charts-yellow, #e8b84d) 70%,
        var(--vscode-charts-red, #d64545) 100%
      );
      transition: width 120ms ease-out;
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
    details.thinking {
      margin: 0 0 8px 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-textCodeBlock-background, var(--bg)) 75%, transparent);
    }
    details.thinking summary {
      list-style: none;
      cursor: pointer;
      padding: 6px 8px;
      font-size: 12px;
      color: var(--muted);
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    details.thinking summary::-webkit-details-marker { display: none; }
    details.thinking summary::before {
      content: "\\25B6";
      font-size: 9px;
      opacity: 0.8;
      transform: translateY(1px);
      transition: transform 120ms ease;
    }
    details.thinking[open] summary::before {
      transform: rotate(90deg) translateX(1px);
    }
    .thinking-body {
      border-top: 1px solid var(--border);
      padding: 8px 10px;
      color: var(--fg);
      font-size: 12px;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
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
`;
