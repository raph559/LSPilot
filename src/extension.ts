import * as vscode from "vscode";
import { LSPilotChatViewProvider } from "./chat/lspilotChatViewProvider";
import { LMStudioClient } from "./client/lmStudioClient";
import { loadModelWithProgress, selectModel } from "./commands/selectModel";

let activeClient: LMStudioClient | undefined;
let suppressRestoreUntil = 0;

export function activate(context: vscode.ExtensionContext): void {
  const client = new LMStudioClient();
  activeClient = client;
  const chatProvider = new LSPilotChatViewProvider(client, context.extensionUri);
  const lastRequestByUri = new Map<string, number>();
  let restoringModel = false;

  const restoreRememberedModel = async (): Promise<void> => {
    const settings = client.getSettings();
    if (!settings.model || restoringModel || Date.now() < suppressRestoreUntil) {
      return;
    }

    restoringModel = true;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `LSPilot: Restoring model "${settings.model}"`,
          cancellable: true
        },
        async (progress, progressToken) => {
          await loadModelWithProgress(client, settings.model, progress, progressToken);
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(`LSPilot could not restore model "${settings.model}": ${message}`);
    } finally {
      restoringModel = false;
    }
  };

  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _ctx, token) {
      const settings = client.getSettings();
      if (!settings.enabled) {
        return [];
      }

      if (settings.minRequestGapMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settings.minRequestGapMs));
        if (token.isCancellationRequested) {
          return [];
        }
      }

      try {
        const generated = await client.generateInlineCompletion(document, position, token);
        if (!generated || token.isCancellationRequested) {
          return [];
        }

        return [new vscode.InlineCompletionItem(generated, new vscode.Range(position, position))];
      } catch (e) {
        // If the request is aborted due to typing, silently ignore.
        if (e instanceof Error && e.message.includes("aborted")) {
          return [];
        }
        console.error("LSPilot Inline Completion Error:", e);
        return [];
      }
    }
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LSPilotChatViewProvider.viewType, chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("lspilot.baseUrl") || event.affectsConfiguration("lspilot.model")) {
        client.invalidateModelCache();
        void restoreRememberedModel();
      }
      if (
        event.affectsConfiguration("lspilot.model") ||
        event.affectsConfiguration("lspilot.chatSystemPrompt") ||
        event.affectsConfiguration("lspilot.chatMaxTokens")
      ) {
        chatProvider.refresh();
      }
    }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.commands.registerCommand("lspilot.openChat", async () => {
      await vscode.commands.executeCommand(`${LSPilotChatViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand("lspilot.selectModel", async () => {
      suppressRestoreUntil = Date.now() + 5000;
      await selectModel(client);
      chatProvider.refresh();
    }),
    vscode.commands.registerCommand("lspilot.clearChat", () => {
      chatProvider.clearChat(true);
    }),
    vscode.commands.registerCommand("lspilot.triggerInlineCompletion", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }),
    vscode.commands.registerCommand("lspilot.testConnection", async () => {
      const tokenSource = new vscode.CancellationTokenSource();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "LSPilot: Testing LM Studio connection",
          cancellable: true
        },
        async (_progress, progressToken) => {
          const cancelSub = progressToken.onCancellationRequested(() => tokenSource.cancel());
          try {
            const result = await client.testConnection(tokenSource.token);
            const sample = result.sample || "(empty response)";
            vscode.window.showInformationMessage(`LSPilot connected to model "${result.model}". Sample: ${sample}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`LSPilot connection failed: ${message}`);
          } finally {
            cancelSub.dispose();
            tokenSource.dispose();
          }
        }
      );
    })
  );

  void restoreRememberedModel();
}

export async function deactivate(): Promise<void> {
  if (!activeClient) {
    return;
  }

  const settings = activeClient.getSettings();
  if (!settings.model) {
    return;
  }

  const tokenSource = new vscode.CancellationTokenSource();
  try {
    await activeClient.unloadModel(settings.model, tokenSource.token);
  } catch {
    // Best effort on shutdown.
  } finally {
    tokenSource.dispose();
    activeClient = undefined;
  }
}
