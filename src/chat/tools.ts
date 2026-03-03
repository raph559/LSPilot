import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

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

export async function executeTool(name: string, argsString: string): Promise<string> {
  let args;
  try {
    args = JSON.parse(argsString);
  } catch (e) {
    return `Error: Invalid JSON arguments: ${argsString}`;
  }

  try {
    switch (name) {
      case "readFile": {
        const fullPath = resolvePath(args.filePath);
        const data = await fs.readFile(fullPath, 'utf8');
        return data;
      }
      case "writeFile": {
        const fullPath = resolvePath(args.filePath);
        await fs.writeFile(fullPath, args.content, 'utf8');
        return `Successfully wrote to ${args.filePath}`;
      }
      case "listDirectory": {
        const fullPath = resolvePath(args.dirPath);
        const files = await fs.readdir(fullPath);
        return files.join('\n');
      }
      case "runCommand": {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let cwd = process.cwd();
        if (workspaceFolders && workspaceFolders.length > 0) {
          cwd = workspaceFolders[0].uri.fsPath;
        }
        const { stdout, stderr } = await execAsync(args.command, { cwd });
        return (stdout ? stdout.toString() : "") + (stderr ? "\nSTDERR:\n" + stderr.toString() : "");
      }
      default:
        return `Error: Unknown tool ${name}`;
    }
  } catch (error: any) {
    return `Error executing ${name}: ${error.message}`;
  }
}
