# LSPilot

LSPilot is a VS Code extension that provides Copilot-style inline code suggestions using LM Studio's local OpenAI-compatible API.

## Features

- Inline ghost-text completions in the editor.
- Manual trigger command: `LSPilot: Trigger Inline Completion`.
- Connection diagnostics: `LSPilot: Test LM Studio Connection`.
- Configurable model, endpoint, token limits, timeout, and prompt.

## Requirements

- VS Code 1.88.0+
- Node.js 18+ (for extension development)
- LM Studio running with:
  - a model loaded
  - local server started (OpenAI-compatible API)

Default endpoint expected by this extension: `http://127.0.0.1:1234/v1`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Build:

```bash
npm run compile
```

3. Open this folder in VS Code.
4. Press `F5` to launch an Extension Development Host.
5. In the new window, open any code file and start typing.

Inline suggestions should appear and can be accepted with the usual inline suggestion keybindings (typically `Tab`).

## Extension Settings

- `lspilot.enabled`: Enable/disable suggestions.
- `lspilot.baseUrl`: LM Studio API base URL.
- `lspilot.model`: Model ID (empty = auto-pick first loaded model).
- `lspilot.temperature`: Sampling temperature.
- `lspilot.maxTokens`: Max completion tokens.
- `lspilot.timeoutMs`: Request timeout.
- `lspilot.minRequestGapMs`: Request throttle per document.
- `lspilot.maxLines`: Max lines returned per suggestion.
- `lspilot.systemPrompt`: System prompt controlling suggestion style.

## Notes

- If suggestions do not appear, run `LSPilot: Test LM Studio Connection` from the Command Palette.
- If auto-model detection fails, set `lspilot.model` explicitly.
