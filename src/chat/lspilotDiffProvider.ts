import * as vscode from 'vscode';

export class LSPilotDiffProvider implements vscode.TextDocumentContentProvider {
  private static instance: LSPilotDiffProvider;
  private contents = new Map<string, string>();

  public static getInstance(): LSPilotDiffProvider {
    if (!LSPilotDiffProvider.instance) {
      LSPilotDiffProvider.instance = new LSPilotDiffProvider();
    }
    return LSPilotDiffProvider.instance;
  }

  public registerContent(id: string, content: string): void {
    this.contents.set(id, content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? "File created.";
  }
}
