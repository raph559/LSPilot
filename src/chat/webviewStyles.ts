import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export function getWebviewStyles(extensionUri: vscode.Uri): string {
    const mdCssPath = path.join(extensionUri.fsPath, "node_modules", "github-markdown-css", "github-markdown.css");
    const vsCssPath = path.join(extensionUri.fsPath, "node_modules", "highlight.js", "styles", "vs.min.css");
    const vs2015CssPath = path.join(extensionUri.fsPath, "node_modules", "highlight.js", "styles", "vs2015.min.css");
    
    let mdCss = "";
    let vsCss = "";
    let vs2015Css = "";
    
    try {
        mdCss = fs.readFileSync(mdCssPath, "utf8");
        vsCss = fs.readFileSync(vsCssPath, "utf8");
        vs2015Css = fs.readFileSync(vs2015CssPath, "utf8");
    } catch (e) {
        console.error("Failed to load markdown/highlight css", e);
    }

    return `
    ${mdCss}
    
    /* VS Code Theme aware highlight.js mapping */
    body.vscode-light .hljs { ${vsCss} }
    body.vscode-dark .hljs, body.vscode-high-contrast .hljs { ${vs2015Css} }

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
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
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
    .button-group { display: flex; gap: 8px; align-items: center; }
    .hidden { display: none !important; }
    button {
      font-family: inherit;
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
    .icon-toggle {
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      position: relative;
      line-height: 1;
      transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .icon-toggle i { font-size: 15px; }
    .icon-toggle:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent));
      color: var(--fg);
    }
    .icon-toggle.supported-off {
      color: var(--vscode-descriptionForeground, var(--muted));
      background: color-mix(in srgb, var(--border) 22%, transparent);
      border-color: color-mix(in srgb, var(--border) 85%, var(--fg) 15%);
    }
    .icon-toggle.active {
      color: var(--vscode-button-foreground, #ffffff);
      border-color: var(--vscode-focusBorder);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--vscode-focusBorder) 68%, transparent),
        color-mix(in srgb, var(--vscode-button-background) 85%, var(--vscode-focusBorder) 15%)
      );
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent), 0 0 10px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent);
    }
    .icon-toggle.crossed::after {
      content: "";
      position: absolute;
      width: 18px;
      height: 2px;
      background: var(--vscode-errorForeground, #d64545);
      transform: rotate(-38deg);
      border-radius: 99px;
      opacity: 1;
    }
    .icon-toggle.unsupported {
      color: var(--vscode-disabledForeground, var(--muted));
      border-color: color-mix(in srgb, var(--border) 72%, var(--vscode-errorForeground, #d64545) 28%);
      border-style: dashed;
      background: color-mix(in srgb, var(--border) 18%, transparent);
      opacity: 0.95;
    }
    .icon-toggle.unsupported:hover {
      background: color-mix(in srgb, var(--border) 18%, transparent);
      color: var(--vscode-disabledForeground, var(--muted));
    }
    .icon-toggle:disabled {
      opacity: 0.75;
    }
    .icon-toggle.active:disabled {
      opacity: 0.95;
    }
    .icon-toggle.unsupported:disabled {
      opacity: 0.72;
    }
    
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
    .msg-wrapper.tool { align-self: flex-start; width: 100%; margin-top: -8px; }
    .msg-wrapper.tool .role { display: none; }

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
    .msg.tool-msg-container {
      background: transparent;
      padding: 0;
      border: none;
      margin-left: 8px;
    }
    .tool-card {
      margin-top: 4px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg);
      overflow: hidden;
    }
    .tool-details {
      /* now part of tool-card */
    }
    .tool-summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
      padding: 6px 10px;
      user-select: none;
    }
    .tool-summary:hover {
      background: var(--assistant-bg);
    }
    .tool-summary b {
      color: var(--fg);
    }
    .tool-output-pre {
      margin: 0;
      padding: 0;
      border-top: 1px solid var(--border);
      background: var(--user-bg);
      max-height: 250px;
      overflow-y: auto;
    }
    .tool-output-code {
      display: block;
      padding: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      color: var(--muted);
    }
    .inline-diff-view {
      display: flex;
      flex-direction: column;
      width: 100%;
      font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
      font-size: 12px;
      line-height: 1.5;
      background: transparent;
      padding: 4px 0;
    }
    .diff-line {
      display: flex;
      width: 100%;
      user-select: text;
    }
    .diff-marker {
      flex: 0 0 24px;
      text-align: center;
      color: var(--muted);
      opacity: 0.7;
      user-select: none;
    }
    .diff-content {
      flex: 1;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .diff-added {
      background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.15));
    }
    .diff-added .diff-content {
      color: var(--vscode-diffEditor-insertedTextForeground, inherit);
    }
    .diff-removed {
      background-color: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.15));
    }
    .diff-removed .diff-content {
      color: var(--vscode-diffEditor-removedTextForeground, inherit);
    }
    .diff-unchanged {
      background-color: transparent;
      color: var(--muted);
    }
    .global-pending-edits {
      margin: 0 0 8px 0;
      padding: 0;
      width: 100%;
    }
    .global-edits-dropdown {
      background: transparent;
      width: 100%;
    }
    .global-edits-summary {
      list-style: none;
      cursor: pointer;
      padding: 4px 0;
      font-size: 12px;
      user-select: none;
      background: transparent;
      border-bottom: 1px solid transparent;
      transition: opacity 0.2s;
    }
    .global-edits-summary:hover {
      opacity: 0.8;
    }
    .global-edits-dropdown[open] .global-edits-summary {
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 4px;
    }
    .global-edits-summary::-webkit-details-marker { display: none; }
    .global-edits-dropdown[open] .chevron { transform: rotate(90deg); }
    
    .global-edits-list {
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .global-edit-card {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border: 1px solid transparent;
      border-radius: var(--border-radius);
      background: transparent;
      position: relative;
    }
    .global-edit-card:hover {
      background: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.31));
      border-color: var(--border);
    }
    .hover-actions {
      display: none;
      align-items: center;
      gap: 4px;
      margin-left: auto;
    }
    .global-edit-card:hover .hover-actions {
      display: flex;
    }
    .icon-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    }
    .icon-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent));
      color: var(--vscode-editor-foreground);
    }
    
    .edit-actions-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 12px;
      margin-top: 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--assistant-bg);
    }
    .edit-file-name {
      font-family: inherit;
      font-size: 11px;
      color: var(--fg);
      display: flex;
      align-items: center;
    }
    .edit-actions-buttons {
      display: flex;
      gap: 6px;
    }
    .edit-status {
      font-size: 11px;
      color: var(--muted);
      padding: 4px 0;
    }
    .tool-action-btn {
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid transparent;
    }
    .tool-action-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .tool-action-btn.secondary {
      background: var(--user-bg);
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .tool-action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent));
    }
    .markdown-body {
        background-color: transparent !important;
        color: var(--fg) !important;
        font-family: inherit !important;
        font-size: 13px !important;
    }
    
    .markdown-body pre,
    .markdown-body code,
    .markdown-body pre code {
      font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace) !important;
      font-size: var(--vscode-editor-font-size, 13px) !important;
    }
    
    .markdown-body pre {
      padding: 10px 0;
      overflow-x: auto;
      margin: 0;
      background-color: transparent !important;
    }

    .markdown-body pre code {
      padding: 0 10px;
      display: block;
      counter-reset: line;
      line-height: 1.5;
      background-color: transparent !important;
    }

    .ln {
      counter-increment: line;
      display: inline-block;
      width: 24px;
      margin-left: -10px;
      padding-right: 12px;
      text-align: right;
      color: var(--muted);
      opacity: 0.5;
      user-select: none;
    }
    .ln::before {
      content: counter(line);
    }

    .code-block-wrapper {
      margin: 8px 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .code-block-header {
      background: color-mix(in srgb, var(--vscode-editor-foreground) 5%, var(--vscode-editor-background));
      padding: 4px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .code-block-lang {
      font-size: 11px;
      color: var(--muted);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .code-block-copy {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: all 0.2s;
    }
    .code-block-copy:hover {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent));
      color: var(--vscode-editor-foreground);
    }
    .code-block-copy svg { opacity: 0.8; }
    .code-block-copy:active svg { transform: scale(0.9); }
    .code-block-copy.success { color: var(--vscode-charts-green, #4caf50); }
    
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
      padding: 16px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      z-index: 10;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .input-wrapper {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--input-bg);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: var(--border-radius);
      padding: 8px;
    }
    .input-wrapper:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    textarea {
      width: 100%;
      min-height: 44px;
      max-height: 200px;
      border: none;
      background: transparent;
      color: var(--input-fg);
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
      padding: 4px;
      line-height: 1.4;
    }
    textarea::placeholder { color: var(--muted); }
    textarea:disabled { opacity: 0.5; cursor: not-allowed; }
    .send-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 4px;
    }
    .hint {
      color: var(--muted);
      font-size: 11px;
      opacity: 0.7;
    }
    
    /* Scoped GitHub overrides */
    .markdown-body a { color: var(--vscode-textLink-foreground) !important; }
    .markdown-body table { width: 100% !important; margin: 12px 0 !important; }
    .markdown-body th, .markdown-body td { 
      border: 1px solid var(--border) !important; 
      background-color: transparent !important;
      color: var(--fg) !important;
    }
    .markdown-body blockquote {
      color: var(--muted) !important;
      border-left-color: var(--vscode-textBlockQuote-border) !important;
    }
    `;
}
