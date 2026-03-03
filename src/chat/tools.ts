import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as diff from 'diff';

const execAsync = promisify(cp.exec);

export const toolsDefinition = [
  {
    type: "function",
    function: {
      name: "readFile",
      description: "Read the contents of a file in the workspace",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "The relative or absolute path of the file" }
        },
        required: ["filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "writeFile",
      description: "Write content to a file in the workspace",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "The relative or absolute path of the file" },
          content: { type: "string", description: "The content to write" }
        },
        required: ["filePath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "listDirectory",
      description: "List the contents of a directory in the workspace",
      parameters: {
        type: "object",
        properties: {
          dirPath: { type: "string", description: "The relative or absolute path of the directory" }
        },
        required: ["dirPath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "runCommand",
      description: "Run a shell/terminal command in the workspace directory",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" }
        },
        required: ["command"]
      }
    }
  }
];

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error("No workspace folder open");
  }
  return path.join(workspaceFolders[0].uri.fsPath, filePath);
}

export interface ToolResult {
  text: string;
  fileEdit?: {
    filePath: string;
    oldContent: string | null;
    newContent: string;
    additions?: number;
    deletions?: number;
    diffs?: Array<{ added?: boolean; removed?: boolean; value: string; count?: number }>;
  };
}

export async function executeTool(name: string, argsString: string): Promise<ToolResult> {
  let args;
  try {
    args = JSON.parse(argsString);
  } catch (e) {
    return { text: `Error: Invalid JSON arguments: ${argsString}` };
  }

  try {
    switch (name) {
      case "readFile": {
        const fullPath = resolvePath(args.filePath);
        const data = await fs.readFile(fullPath, 'utf8');
        return { text: data };
      }
      case "writeFile": {
        const fullPath = resolvePath(args.filePath);
        let oldContent: string | null = null;
        try {
          oldContent = await fs.readFile(fullPath, 'utf8');
        } catch (err: any) {
          // If file doesn't exist, it's fine, we will create it
          if (err.code !== 'ENOENT') {
            throw err;
          }
        }
        await fs.writeFile(fullPath, args.content, 'utf8');
        
        let additions = 0;
        let deletions = 0;
        let diffs: any[] | undefined;
        if (oldContent === null) {
          additions = args.content.split('\n').length;
          diffs = [{ added: true, value: args.content }];
        } else {
          diffs = diff.diffLines(oldContent, args.content);
          for (const change of diffs) {
            if (change.added) additions += change.count || 0;
            if (change.removed) deletions += change.count || 0;
          }
        }

        return { 
          text: `Successfully wrote to ${args.filePath}`,
          fileEdit: {
            filePath: fullPath,
            oldContent: oldContent,
            newContent: args.content,
            additions,
            deletions,
            diffs
          }
        };
      }
      case "listDirectory": {
        const fullPath = resolvePath(args.dirPath);
        const files = await fs.readdir(fullPath);
        return { text: files.join('\n') };
      }
      case "runCommand": {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let cwd = process.cwd();
        if (workspaceFolders && workspaceFolders.length > 0) {
          cwd = workspaceFolders[0].uri.fsPath;
        }
        const { stdout, stderr } = await execAsync(args.command, { cwd });
        return { text: (stdout ? stdout.toString() : "") + (stderr ? "\nSTDERR:\n" + stderr.toString() : "") };
      }
      default:
        return { text: `Error: Unknown tool ${name}` };
    }
  } catch (error: any) {
    return { text: `Error executing ${name}: ${error.message}` };
  }
}
