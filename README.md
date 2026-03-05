# LSPilot

LSPilot is a VS Code extension that provides Copilot-style inline code suggestions using LM Studio's local OpenAI-compatible API.

## Features

- Inline ghost-text completions in the editor.
- Built-in chat sidebar view (`LSPilot` activity bar icon).
- Chat tool calls can run terminal commands in a persistent `LSPilot Terminal`, with live output streamed back into chat.
- Manual trigger command: `LSPilot: Trigger Inline Completion`.
- Connection diagnostics: `LSPilot: Test LM Studio Connection`.
- Model picker command: `LSPilot: Select Model`.
- Chat reset command: `LSPilot: Clear Chat`.
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

To use chat, open the `LSPilot` icon in the activity bar and send a message.

## Extension Settings

- `lspilot.enabled`: Enable/disable suggestions.
- `lspilot.baseUrl`: LM Studio API base URL.
- `lspilot.model`: Model ID (empty = no model selected).
- `lspilot.temperature`: Sampling temperature.
- `lspilot.maxTokens`: Max completion tokens.
- `lspilot.chatMaxTokens`: Max chat response tokens.
- `lspilot.timeoutMs`: Request timeout.
- `lspilot.chatTimeoutMs`: Timeout used for chat responses.
- `lspilot.modelLoadTimeoutMs`: Timeout used when loading a selected model.
- `lspilot.minRequestGapMs`: Request throttle per document.
- `lspilot.maxLines`: Max lines returned per suggestion.
- `lspilot.systemPrompt`: System prompt controlling suggestion style.
- `lspilot.chatSystemPrompt`: System prompt controlling chat behavior.

## Notes

- If suggestions do not appear, run `LSPilot: Test LM Studio Connection` from the Command Palette.
- If no model is selected, run `LSPilot: Select Model` and choose one.
