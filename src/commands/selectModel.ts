import * as vscode from "vscode";
import { LMStudioClient } from "../client/lmStudioClient";

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function buildLoadProgressMessage(model: string, dots: string, sizeBytes?: number): string {
  const memory = typeof sizeBytes === "number" ? ` | Memory: ${formatBytes(sizeBytes)}` : "";
  return `Loading "${model}"${dots}${memory}`;
}

export async function loadModelWithProgress(
  client: LMStudioClient,
  model: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<void> {
  let modelSizeBytes: number | undefined;
  try {
    modelSizeBytes = await client.getModelSizeBytes(model, token);
  } catch {
    // Best effort only.
  }

  let dots = ".";
  progress.report({ message: buildLoadProgressMessage(model, dots, modelSizeBytes) });

  const timer = setInterval(() => {
    dots = dots.length >= 3 ? "." : dots + ".";
    // We omit 'increment' entirely, which causes the progress bar to show an indeterminate animation
    progress.report({ message: buildLoadProgressMessage(model, dots, modelSizeBytes) });
  }, 500);

  try {
    await client.loadModel(model, token);
  } finally {
    clearInterval(timer);
  }
}

export async function selectModel(client: LMStudioClient): Promise<void> {
  const tokenSource = new vscode.CancellationTokenSource();

  try {
    const models = await client.listModels(tokenSource.token);
    const settings = client.getSettings();

    const picks = [
      {
        label: "None",
        description: "Do not select any model by default",
        model: ""
      },
      ...models.map((model) => ({
        label: model,
        description: "Use this model for completions and chat",
        model
      }))
    ];

    const selected = await vscode.window.showQuickPick(picks, {
      title: "LSPilot: Select Model",
      placeHolder: "Choose the LM Studio model to use",
      matchOnDescription: true
    });

    if (!selected) {
      return;
    }

    if (selected.model === settings.model) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "LSPilot: Applying model selection",
        cancellable: true
      },
      async (progress, progressToken) => {
        progress.report({ message: "Saving model setting..." });

        await vscode.workspace
          .getConfiguration("lspilot")
          .update("model", selected.model, vscode.ConfigurationTarget.Global);

        client.invalidateModelCache();

        if (selected.model) {
          await loadModelWithProgress(client, selected.model, progress, progressToken);
        } else {
          progress.report({ message: "Unloading current model..." });
          if (settings.model) {
            await client.unloadModel(settings.model, progressToken);
          }
          progress.report({ message: "Clearing selected model." });
        }
      }
    );

    vscode.window.showInformationMessage(
      selected.model ? `LSPilot model set and loaded: "${selected.model}".` : "LSPilot model cleared."
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Unable to apply selected model: ${message}`);
  } finally {
    tokenSource.dispose();
  }
}
