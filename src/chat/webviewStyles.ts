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
      --user-bg: var(--vscode-button-secondaryBackground, color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent));
      --assistant-bg: color-mix(in srgb, var(--vscode-button-background) 10%, transparent);
      --shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      --border-radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      color: var(--fg);
      background: var(--bg);
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      z-index: 10;
    }
    .model {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .context {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 110px;
      max-width: 190px;
      width: 100%;
    }
    .context.hidden { display: none; }
    .context-in-composer { max-width: none; min-width: 0; }
    .context-label { color: var(--muted); font-size: 11px; line-height: 1; font-weight: 500; }
    .context-track {
      width: 100%;
      height: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--border) 40%, transparent);
    }
    .context-fill {
      width: 100%;
      height: 100%;
      background: linear-gradient(
        90deg,
        var(--vscode-charts-green, #4caf50) 0%,
        var(--vscode-charts-yellow, #e8b84d) 70%,
        var(--vscode-charts-red, #d64545) 100%
      );
      clip-path: inset(0 100% 0 0);
      transition: clip-path 0.3s ease-out;
    }
    .actions { display: flex; gap: 8px; }
    button {
      border: 1px solid transparent;
      background: var(--btn-bg);
      color: var(--btn-fg);
      padding: 6px 12px;
      cursor: pointer;
      border-radius: var(--border-radius);
      font-size: 12px;
      font-weight: 500;
      transition: all 0.2s;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary { background: transparent; border-color: var(--border); color: var(--fg); }
    button.secondary:hover { background: var(--user-bg); border-color: var(--muted); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      scroll-behavior: smooth;
    }
    .msg-wrapper {
      display: flex;
      flex-direction: column;
      max-width: 90%;
    }
    .msg-wrapper.user { align-self: flex-end; }
    .msg-wrapper.assistant { align-self: flex-start; }
    
    .role {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 6px;
      text-transform: capitalize;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .msg-wrapper.user .role { justify-content: flex-end; }
    
    .msg {
      border-radius: var(--border-radius);
      padding: 12px 14px;
      line-height: 1.5;
      font-size: 13px;
      word-break: break-word;
      position: relative;
    }
    .msg.user {
      background: var(--user-bg);
      border-bottom-right-radius: 4px;
    }
    .msg.assistant {
      background: var(--assistant-bg);
      border-bottom-left-radius: 4px;
      border: 1px solid var(--border);
    }
    
    .msg-content p, .thinking-body p { margin-bottom: 8px; }
    .msg-content p:last-child, .thinking-body p:last-child { margin-bottom: 0; }
    .msg-content pre, .thinking-body pre {
      background: var(--vscode-editor-background);
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
      border: 1px solid var(--border);
    }
    .msg-content code, .thinking-body code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      background: var(--vscode-editor-background);
      padding: 2px 4px;
      border-radius: 4px;
      color: var(--vscode-editor-foreground);
    }
    .msg-content pre code, .thinking-body pre code {
      padding: 0;
      background: transparent;
    }
    .msg-content ul, .msg-content ol, .thinking-body ul, .thinking-body ol { margin: 8px 0 8px 24px; }
    .msg-content blockquote, .thinking-body blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      padding-left: 12px;
      margin: 8px 0;
      color: var(--muted);
    }
    .msg-content table, .thinking-body table {
      border-collapse: collapse;
      margin: 12px 0;
      width: 100%;
      font-size: 13px;
    }
    .msg-content th, .msg-content td, .thinking-body th, .thinking-body td {
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
    }
    .msg-content th, .thinking-body th {
      background: color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent);
      font-weight: 600;
    }

    /* Highlight.js mapped to standard VS Code colors */
    .hljs { color: var(--vscode-editor-foreground); }
    .hljs-keyword, .hljs-keyword.hljs-function { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
    .hljs-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .hljs-comment { color: var(--vscode-editorCodeLens-modifiedForeground, #6a9955); font-style: italic; }
    .hljs-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .hljs-function, .hljs-title { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa); }
    .hljs-variable, .hljs-params { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }
    .hljs-type, .hljs-built_in { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
    .hljs-literal, .hljs-symbol { color: var(--vscode-symbolIcon-constantForeground, #4fc1ff); }
    .hljs-attr, .hljs-attribute { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .hljs-meta { color: var(--vscode-symbolIcon-colorForeground, #c586c0); }
    .hljs-tag, .hljs-name { color: var(--vscode-symbolIcon-textForeground, #569cd6); }
    .hljs-operator, .hljs-punctuation { color: var(--vscode-editor-foreground); }

    details.thinking {
      margin: 0 0 12px 0;
      border: 1px solid var(--border);
      border-radius: var(--border-radius);
      overflow: hidden;
      background: color-mix(in srgb, var(--vscode-editor-background) 50%, transparent);
    }
    details.thinking summary {
      list-style: none;
      cursor: pointer;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--muted);
      user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
      background: var(--assistant-bg);
    }
    details.thinking summary::-webkit-details-marker { display: none; }
    details.thinking summary::before {
      content: "\\25B6";
      font-size: 10px;
      opacity: 0.7;
      transition: transform 0.2s ease;
    }
    details.thinking[open] summary::before { transform: rotate(90deg); }
    .thinking-body {
      border-top: 1px solid var(--border);
      padding: 12px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }
    
    .timer {
      font-size: 11px;
      color: var(--muted);
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .timer::before {
      content: "⏱";
      font-size: 12px;
    }
    .msg-wrapper.user .timer { justify-content: flex-end; }
    
    .composer {
      border-top: 1px solid var(--border);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--bg);
      box-shadow: 0 -4px 16px rgba(0,0,0,0.05);
      z-index: 10;
    }
    .input-wrapper {
      position: relative;
      display: flex;
      flex-direction: column;
    }
    textarea {
      width: 100%;
      min-height: 80px;
      max-height: 300px;
      resize: none;
      border: 1px solid var(--border);
      border-radius: var(--border-radius);
      padding: 12px;
      padding-bottom: 40px;
      background: var(--input-bg);
      color: var(--input-fg);
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      line-height: 1.5;
      transition: border-color 0.2s;
    }
    textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
    textarea::placeholder { color: var(--muted); opacity: 0.7; }
    
    .send-row {
      position: absolute;
      bottom: 8px;
      left: 12px;
      right: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .hint {
      color: var(--muted);
      font-size: 11px;
      opacity: 0.8;
      pointer-events: none;
    }
    #send {
      padding: 4px 16px;
      border-radius: 6px;
    }
`;
