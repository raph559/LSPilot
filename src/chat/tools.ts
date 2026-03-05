import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import * as diff from "diff";

const execAsync = promisify(cp.exec);

const maxToolOutputChars = 120_000;
const maxDirectoryEntries = 5_000;
const maxSearchResults = 200;
const maxSearchCandidateFiles = 2_000;
const maxSearchFileBytes = 2 * 1024 * 1024;
const maxCommandTimeoutMs = 120_000;
const maxCommandBufferBytes = 4 * 1024 * 1024;
const maxDeletePreviewBytes = 1_500_000;

interface ManagedTerminal {
  id: string;
  terminal: vscode.Terminal;
  process: cp.ChildProcess;
  writeEmitter: vscode.EventEmitter<string>;
  buffer: string;
  exitCode?: number;
}
const managedTerminals = new Map<string, ManagedTerminal>();
let terminalIdCounter = 1;

function createFunctionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required
      }
    }
  };
}

export const toolsDefinition = [
  createFunctionTool(
    "readFile",
    "Read the full text contents of a file",
    {
      filePath: { type: "string", description: "Relative or absolute file path" }
    },
    ["filePath"]
  ),
  createFunctionTool(
    "readFileRange",
    "Read a line range from a text file (1-based inclusive)",
    {
      filePath: { type: "string", description: "Relative or absolute file path" },
      startLine: { type: "number", description: "Start line (1-based)" },
      endLine: { type: "number", description: "End line (1-based inclusive)" }
    },
    ["filePath", "startLine", "endLine"]
  ),
  createFunctionTool(
    "writeFile",
    "Write full content to a file (create or overwrite)",
    {
      filePath: { type: "string", description: "Relative or absolute file path" },
      content: { type: "string", description: "File content to write" }
    },
    ["filePath", "content"]
  ),
  createFunctionTool(
    "appendFile",
    "Append content to the end of a file (create if missing)",
    {
      filePath: { type: "string", description: "Relative or absolute file path" },
      content: { type: "string", description: "Content to append" }
    },
    ["filePath", "content"]
  ),
  createFunctionTool(
    "replaceInFile",
    "Replace text in a file",
    {
      filePath: { type: "string", description: "Relative or absolute file path" },
      searchValue: { type: "string", description: "Exact text to find" },
      replaceValue: { type: "string", description: "Replacement text" },
      replaceAll: { type: "boolean", description: "Replace all matches (default true)" }
    },
    ["filePath", "searchValue", "replaceValue"]
  ),
  createFunctionTool(
    "listDirectory",
    "List a directory's entries",
    {
      dirPath: { type: "string", description: "Relative or absolute directory path" },
      recursive: { type: "boolean", description: "List recursively (default false)" },
      includeHidden: { type: "boolean", description: "Include hidden dotfiles (default false)" }
    },
    ["dirPath"]
  ),
  createFunctionTool(
    "createDirectory",
    "Create a directory",
    {
      dirPath: { type: "string", description: "Relative or absolute directory path" },
      recursive: { type: "boolean", description: "Create parent directories (default true)" }
    },
    ["dirPath"]
  ),
  createFunctionTool(
    "deletePath",
    "Delete a file or directory",
    {
      targetPath: { type: "string", description: "Relative or absolute path to delete" },
      recursive: { type: "boolean", description: "Allow deleting non-empty directories (default true)" }
    },
    ["targetPath"]
  ),
  createFunctionTool(
    "renamePath",
    "Rename or move a file/directory",
    {
      oldPath: { type: "string", description: "Existing relative or absolute path" },
      newPath: { type: "string", description: "New relative or absolute path" }
    },
    ["oldPath", "newPath"]
  ),
  createFunctionTool(
    "copyPath",
    "Copy a file or directory",
    {
      sourcePath: { type: "string", description: "Source relative or absolute path" },
      destinationPath: { type: "string", description: "Destination relative or absolute path" },
      overwrite: { type: "boolean", description: "Overwrite destination if it exists (default false)" },
      recursive: { type: "boolean", description: "Copy directories recursively (default true)" }
    },
    ["sourcePath", "destinationPath"]
  ),
  createFunctionTool(
    "pathExists",
    "Check if a path exists",
    {
      targetPath: { type: "string", description: "Relative or absolute path to check" }
    },
    ["targetPath"]
  ),
  createFunctionTool(
    "fileStats",
    "Get stat metadata for a file or directory",
    {
      targetPath: { type: "string", description: "Relative or absolute path" }
    },
    ["targetPath"]
  ),
  createFunctionTool(
    "findFiles",
    "Find files by glob pattern",
    {
      globPattern: { type: "string", description: "Glob include pattern, e.g. **/*.ts" },
      excludePattern: { type: "string", description: "Glob exclude pattern" },
      maxResults: { type: "number", description: "Maximum number of matches (default 100)" }
    },
    ["globPattern"]
  ),
  createFunctionTool(
    "searchInFiles",
    "Search text in workspace files",
    {
      query: { type: "string", description: "Text pattern to search for" },
      includePattern: { type: "string", description: "Optional include glob pattern" },
      maxResults: { type: "number", description: "Maximum number of matches (default 50)" },
      caseSensitive: { type: "boolean", description: "Case sensitive search (default false)" }
    },
    ["query"]
  ),
  createFunctionTool(
    "runCommand",
    "Run a shell/terminal command in the background and return its output. Good for checking state silently.",
    {
      command: { type: "string", description: "Command to execute" },
      cwd: { type: "string", description: "Optional working directory path" },
      timeoutMs: { type: "number", description: "Command timeout in milliseconds (default 60000)" }
    },
    ["command"]
  ),
  createFunctionTool(
    "runInTerminal",
    "Run a realistic shell command inside a VS Code graphical terminal. The AI can read output in real-time.",
    {
      command: { type: "string", description: "Command to execute" },
      cwd: { type: "string", description: "Optional working directory path" },
      isBackground: { type: "boolean", description: "If true, returns immediately while command runs. If false, waits for command to complete." },
      timeoutMs: { type: "number", description: "Command timeout (if not background)" }
    },
    ["command"]
  ),
  createFunctionTool(
    "readTerminal",
    "Read recent unread output from a background terminal.",
    {
      id: { type: "string", description: "Terminal ID" }
    },
    ["id"]
  ),
  createFunctionTool(
    "sendTerminalInput",
    "Send text/keystrokes to a running terminal process.",
    {
      id: { type: "string", description: "Terminal ID" },
      text: { type: "string", description: "Text to send (include \\n for enter)" }
    },
    ["id", "text"]
  )
];

function getWorkspaceRoot(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error("No workspace folder open");
  }
  return workspaceFolders[0].uri.fsPath;
}

function resolvePath(targetPath: string): string {
  const normalized = targetPath.trim();
  if (!normalized) {
    throw new Error("Path cannot be empty");
  }
  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }
  return path.normalize(path.join(getWorkspaceRoot(), normalized));
}

function coerceArgs(rawArgs: unknown): Record<string, unknown> {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return {};
  }
  return rawArgs as Record<string, unknown>;
}

function getRequiredStringArg(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Missing required string argument "${key}"`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`Argument "${key}" cannot be empty`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getBooleanArg(args: Record<string, unknown>, key: string, defaultValue = false): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : defaultValue;
}

function getNumberArg(
  args: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  const value = args[key];
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
  let output = Math.floor(numeric);
  if (typeof min === "number") {
    output = Math.max(min, output);
  }
  if (typeof max === "number") {
    output = Math.min(max, output);
  }
  return output;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function trimToolOutput(text: string, maxChars = maxToolOutputChars): string {
  if (text.length <= maxChars) {
    return text;
  }
  const removed = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[output truncated: ${removed} chars omitted]`;
}

function buildFileEdit(
  filePath: string,
  oldContent: string | null,
  newContent: string
): NonNullable<ToolResult["fileEdit"]> {
  let additions = 0;
  let deletions = 0;
  let diffs: Array<{ added?: boolean; removed?: boolean; value: string; count?: number }> = [];

  if (oldContent === null) {
    additions = newContent.length > 0 ? newContent.split("\n").length : 0;
    diffs = newContent.length > 0 ? [{ added: true, value: newContent }] : [];
  } else {
    const rawDiffs = diff.diffLines(oldContent, newContent);
    diffs = rawDiffs.map((part) => ({
      added: part.added,
      removed: part.removed,
      value: part.value,
      count: part.count
    }));
    for (const part of rawDiffs) {
      if (part.added) {
        additions += part.count || 0;
      } else if (part.removed) {
        deletions += part.count || 0;
      }
    }
  }

  return {
    filePath,
    oldContent,
    newContent,
    additions,
    deletions,
    diffs
  };
}

async function tryReadExistingTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listDirectoryEntries(
  baseDir: string,
  currentRelativeDir: string,
  recursive: boolean,
  includeHidden: boolean,
  output: string[]
): Promise<void> {
  if (output.length >= maxDirectoryEntries) {
    return;
  }

  const fullDir = currentRelativeDir ? path.join(baseDir, currentRelativeDir) : baseDir;
  const entries = await fs.readdir(fullDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) {
      continue;
    }
    const relativeEntry = currentRelativeDir ? path.join(currentRelativeDir, entry.name) : entry.name;
    const display = toPosixPath(relativeEntry) + (entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : "");
    output.push(display);

    if (output.length >= maxDirectoryEntries) {
      return;
    }

    if (recursive && entry.isDirectory()) {
      await listDirectoryEntries(baseDir, relativeEntry, recursive, includeHidden, output);
      if (output.length >= maxDirectoryEntries) {
        return;
      }
    }
  }
}

function buildCommandFailureOutput(error: unknown): string {
  const execError = error as cp.ExecException;
  const stdoutRaw = (execError as { stdout?: unknown }).stdout;
  const stderrRaw = (execError as { stderr?: unknown }).stderr;

  const stdout = typeof stdoutRaw === "string"
    ? stdoutRaw
    : Buffer.isBuffer(stdoutRaw)
      ? stdoutRaw.toString("utf8")
      : "";
  const stderr = typeof stderrRaw === "string"
    ? stderrRaw
    : Buffer.isBuffer(stderrRaw)
      ? stderrRaw.toString("utf8")
      : "";

  const lines = [`Command failed: ${execError.message || "Unknown error"}`];
  if (stdout.trim().length > 0) {
    lines.push(`STDOUT:\n${stdout}`);
  }
  if (stderr.trim().length > 0) {
    lines.push(`STDERR:\n${stderr}`);
  }
  return trimToolOutput(lines.join("\n\n"));
}

export interface ToolResult {
  text: string;
  resolvedPath?: string;
  fileEdit?: {
    filePath: string;
    oldContent: string | null;
    newContent: string;
    additions?: number;
    deletions?: number;
    superseded?: boolean;
    diffs?: Array<{ added?: boolean; removed?: boolean; value: string; count?: number }>;
  };
}

export interface ExecuteToolOptions {
  onUpdate?: (text: string) => void;
}

export async function executeTool(name: string, argsString: string, options?: ExecuteToolOptions): Promise<ToolResult> {
  let parsedArgs: unknown = {};
  try {
    parsedArgs = argsString ? JSON.parse(argsString) : {};
  } catch {
    return { text: `Error: Invalid JSON arguments: ${argsString}` };
  }

  const args = coerceArgs(parsedArgs);

  try {
    switch (name) {
      case "readFile": {
        const filePathArg = getRequiredStringArg(args, "filePath").trim();
        const fullPath = resolvePath(filePathArg);
        const data = await fs.readFile(fullPath, "utf8");
        return { text: data, resolvedPath: fullPath };
      }
      case "readFileRange": {
        const filePathArg = getRequiredStringArg(args, "filePath").trim();
        const fullPath = resolvePath(filePathArg);
        const startLine = getNumberArg(args, "startLine", 1, 1);
        const endLine = getNumberArg(args, "endLine", startLine, startLine);
        if (endLine < startLine) {
          throw new Error("endLine must be greater than or equal to startLine");
        }

        const data = await fs.readFile(fullPath, "utf8");
        const normalized = data.replace(/\r\n/g, "\n");
        const lines = normalized.split("\n");
        if (lines.length === 1 && lines[0] === "") {
          return { text: "", resolvedPath: fullPath };
        }

        const startIndex = Math.max(0, startLine - 1);
        const endIndexExclusive = Math.min(lines.length, endLine);
        if (startIndex >= lines.length) {
          return { text: "", resolvedPath: fullPath };
        }

        const selected = lines.slice(startIndex, endIndexExclusive).join("\n");
        return { text: selected, resolvedPath: fullPath };
      }
      case "writeFile": {
        const filePathArg = getRequiredStringArg(args, "filePath").trim();
        const content = getRequiredStringArg(args, "content", true);
        const fullPath = resolvePath(filePathArg);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        const oldContent = await tryReadExistingTextFile(fullPath);
        await fs.writeFile(fullPath, content, "utf8");

        return {
          text: `Successfully wrote to ${filePathArg}`,
          resolvedPath: fullPath,
          fileEdit: buildFileEdit(fullPath, oldContent, content)
        };
      }
      case "appendFile": {
        const filePathArg = getRequiredStringArg(args, "filePath").trim();
        const content = getRequiredStringArg(args, "content", true);
        const fullPath = resolvePath(filePathArg);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        const oldContent = await tryReadExistingTextFile(fullPath);
        await fs.appendFile(fullPath, content, "utf8");
        const newContent = (oldContent ?? "") + content;

        return {
          text: `Successfully appended to ${filePathArg}`,
          resolvedPath: fullPath,
          fileEdit: buildFileEdit(fullPath, oldContent, newContent)
        };
      }
      case "replaceInFile": {
        const filePathArg = getRequiredStringArg(args, "filePath").trim();
        const searchValue = getRequiredStringArg(args, "searchValue");
        const replaceValue = getRequiredStringArg(args, "replaceValue", true);
        const replaceAll = getBooleanArg(args, "replaceAll", true);
        const fullPath = resolvePath(filePathArg);

        const oldContent = await fs.readFile(fullPath, "utf8");
        let replacementCount = 0;
        let newContent = oldContent;

        if (replaceAll) {
          replacementCount = oldContent.split(searchValue).length - 1;
          if (replacementCount > 0) {
            newContent = oldContent.split(searchValue).join(replaceValue);
          }
        } else {
          const firstIndex = oldContent.indexOf(searchValue);
          if (firstIndex >= 0) {
            replacementCount = 1;
            newContent = oldContent.replace(searchValue, replaceValue);
          }
        }

        if (replacementCount === 0) {
          return { text: `No matches found for "${searchValue}" in ${filePathArg}`, resolvedPath: fullPath };
        }

        await fs.writeFile(fullPath, newContent, "utf8");
        return {
          text: `Replaced ${replacementCount} occurrence${replacementCount === 1 ? "" : "s"} in ${filePathArg}`,
          resolvedPath: fullPath,
          fileEdit: buildFileEdit(fullPath, oldContent, newContent)
        };
      }
      case "listDirectory": {
        const dirPathArg = getRequiredStringArg(args, "dirPath").trim();
        const recursive = getBooleanArg(args, "recursive", false);
        const includeHidden = getBooleanArg(args, "includeHidden", false);
        const fullPath = resolvePath(dirPathArg);

        const entries: string[] = [];
        await listDirectoryEntries(fullPath, "", recursive, includeHidden, entries);
        const output = entries.length > 0 ? entries.join("\n") : "(empty directory)";
        return {
          text: output,
          resolvedPath: fullPath
        };
      }
      case "createDirectory": {
        const dirPathArg = getRequiredStringArg(args, "dirPath").trim();
        const recursive = getBooleanArg(args, "recursive", true);
        const fullPath = resolvePath(dirPathArg);
        await fs.mkdir(fullPath, { recursive });
        return { text: `Created directory ${dirPathArg}`, resolvedPath: fullPath };
      }
      case "deletePath": {
        const targetPathArg = getRequiredStringArg(args, "targetPath").trim();
        const recursive = getBooleanArg(args, "recursive", true);
        const fullPath = resolvePath(targetPathArg);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
          if (recursive) {
            await fs.rm(fullPath, { recursive: true, force: false });
          } else {
            await fs.rmdir(fullPath);
          }
          return { text: `Deleted directory ${targetPathArg}`, resolvedPath: fullPath };
        }

        let fileEdit: ToolResult["fileEdit"];
        if (stat.isFile() && stat.size <= maxDeletePreviewBytes) {
          const fileBuffer = await fs.readFile(fullPath);
          if (!fileBuffer.includes(0)) {
            const oldContent = fileBuffer.toString("utf8");
            fileEdit = buildFileEdit(fullPath, oldContent, "");
          }
        }

        await fs.unlink(fullPath);
        return { text: `Deleted file ${targetPathArg}`, resolvedPath: fullPath, fileEdit };
      }
      case "renamePath": {
        const oldPathArg = getRequiredStringArg(args, "oldPath").trim();
        const newPathArg = getRequiredStringArg(args, "newPath").trim();
        const oldPath = resolvePath(oldPathArg);
        const newPath = resolvePath(newPathArg);
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(oldPath, newPath);
        return { text: `Renamed ${oldPathArg} -> ${newPathArg}`, resolvedPath: newPath };
      }
      case "copyPath": {
        const sourcePathArg = getRequiredStringArg(args, "sourcePath").trim();
        const destinationPathArg = getRequiredStringArg(args, "destinationPath").trim();
        const overwrite = getBooleanArg(args, "overwrite", false);
        const recursive = getBooleanArg(args, "recursive", true);
        const sourcePath = resolvePath(sourcePathArg);
        const destinationPath = resolvePath(destinationPathArg);
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.cp(sourcePath, destinationPath, {
          recursive,
          force: overwrite,
          errorOnExist: !overwrite
        });
        return {
          text: `Copied ${sourcePathArg} -> ${destinationPathArg}`,
          resolvedPath: destinationPath
        };
      }
      case "pathExists": {
        const targetPathArg = getRequiredStringArg(args, "targetPath").trim();
        const fullPath = resolvePath(targetPathArg);
        let exists = true;
        try {
          await fs.access(fullPath);
        } catch {
          exists = false;
        }
        return {
          text: JSON.stringify({ path: fullPath, exists }, null, 2),
          resolvedPath: fullPath
        };
      }
      case "fileStats": {
        const targetPathArg = getRequiredStringArg(args, "targetPath").trim();
        const fullPath = resolvePath(targetPathArg);
        const stat = await fs.stat(fullPath);
        const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";

        return {
          text: JSON.stringify(
            {
              path: fullPath,
              kind,
              sizeBytes: stat.size,
              createdAt: stat.birthtime.toISOString(),
              modifiedAt: stat.mtime.toISOString(),
              accessedAt: stat.atime.toISOString()
            },
            null,
            2
          ),
          resolvedPath: fullPath
        };
      }
      case "findFiles": {
        const globPattern = getRequiredStringArg(args, "globPattern").trim();
        const excludePattern = getOptionalStringArg(args, "excludePattern");
        const maxResults = getNumberArg(args, "maxResults", 100, 1, maxDirectoryEntries);
        const files = await vscode.workspace.findFiles(globPattern, excludePattern, maxResults);
        const lines = files.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort((a, b) => a.localeCompare(b));
        return { text: lines.length > 0 ? lines.join("\n") : "(no files matched)" };
      }
      case "searchInFiles": {
        const query = getRequiredStringArg(args, "query");
        const includePattern = getOptionalStringArg(args, "includePattern");
        const maxResults = getNumberArg(args, "maxResults", 50, 1, maxSearchResults);
        const caseSensitive = getBooleanArg(args, "caseSensitive", false);
        const matches: string[] = [];
        const candidateUris = await vscode.workspace.findFiles(
          includePattern || "**/*",
          undefined,
          maxSearchCandidateFiles
        );
        const needle = caseSensitive ? query : query.toLowerCase();

        outer: for (const uri of candidateUris) {
          let bytes: Uint8Array;
          try {
            bytes = await vscode.workspace.fs.readFile(uri);
          } catch {
            continue;
          }
          if (bytes.length === 0 || bytes.length > maxSearchFileBytes) {
            continue;
          }

          const fileBuffer = Buffer.from(bytes);
          if (fileBuffer.includes(0)) {
            continue;
          }

          const content = fileBuffer.toString("utf8");
          const lines = content.replace(/\r\n/g, "\n").split("\n");
          const relativePath = vscode.workspace.asRelativePath(uri, false);

          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const lineText = lines[lineIndex];
            const haystack = caseSensitive ? lineText : lineText.toLowerCase();
            let fromIndex = 0;

            while (fromIndex <= haystack.length) {
              const hitIndex = haystack.indexOf(needle, fromIndex);
              if (hitIndex < 0) {
                break;
              }

              const preview = lineText.trim().replace(/\s+/g, " ");
              matches.push(`${relativePath}:${lineIndex + 1}:${hitIndex + 1}: ${preview}`);
              if (matches.length >= maxResults) {
                break outer;
              }

              fromIndex = hitIndex + Math.max(needle.length, 1);
            }
          }
        }

        if (matches.length === 0) {
          return { text: "(no matches)" };
        }
        return { text: trimToolOutput(matches.join("\n")) };
      }
      case "runCommand": {
        const command = getRequiredStringArg(args, "command");
        const cwdArg = getOptionalStringArg(args, "cwd");
        const timeoutMs = getNumberArg(args, "timeoutMs", 60_000, 1_000, maxCommandTimeoutMs);

        let cwd = process.cwd();
        if (cwdArg) {
          cwd = resolvePath(cwdArg);
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
          cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: maxCommandBufferBytes,
            windowsHide: true
          });
          const combinedOutput = `${stdout ?? ""}${stderr ? `\nSTDERR:\n${stderr}` : ""}`.trim();
          const text = trimToolOutput(combinedOutput || "(command completed with no output)");
          options?.onUpdate?.(text);
          return { text };
        } catch (error) {
          const text = buildCommandFailureOutput(error);
          options?.onUpdate?.(text);
          return { text };
        }
      }
      case "runInTerminal": {
        const command = getRequiredStringArg(args, "command");
        const cwdArg = getOptionalStringArg(args, "cwd");
        const isBackground = getBooleanArg(args, "isBackground", false);
        const timeoutMs = getNumberArg(args, "timeoutMs", 60000, 1000, maxCommandTimeoutMs);

        let cwd = process.cwd();
        if (cwdArg) {
          cwd = resolvePath(cwdArg);
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
          cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

        const terminalId = `term-${terminalIdCounter++}`;
        const writeEmitter = new vscode.EventEmitter<string>();
        let isOpened = false;
        let pendingWrites: string[] = [];

        const emit = (txt: string) => {
          if (isOpened) {
            writeEmitter.fire(txt);
          } else {
            pendingWrites.push(txt);
          }
        };
        
        let pty: vscode.Pseudoterminal = {
          onDidWrite: writeEmitter.event,
          open: () => {
            isOpened = true;
            pendingWrites.forEach(t => writeEmitter.fire(t));
            pendingWrites = [];
          },
          close: () => {
            const mt = managedTerminals.get(terminalId);
            if (mt) {
               try { mt.process.kill(); } catch (e) {}
               managedTerminals.delete(terminalId);
            }
          },
          handleInput: (data: string) => {
            const mt = managedTerminals.get(terminalId);
            if (mt && mt.process.stdin) {
               mt.process.stdin.write(data);
            }
          }
        };

        const terminal = vscode.window.createTerminal({
          name: `LSPilot (${terminalId})`,
          pty: pty
        });
        terminal.show();

        const child = cp.spawn(command, [], {
          cwd: cwd,
          shell: true,
          env: { ...process.env, FORCE_COLOR: "1" }
        });

        const managed: ManagedTerminal = {
          id: terminalId,
          terminal,
          process: child,
          writeEmitter,
          buffer: ""
        };
        managedTerminals.set(terminalId, managed);

        child.stdout?.on("data", (data: Buffer) => {
          const text = data.toString();
          managed.buffer += text;
          emit(text.replace(/\r?\n/g, "\r\n"));
        });

        child.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();
          managed.buffer += text;
          emit(text.replace(/\r?\n/g, "\r\n"));
        });

        child.on("close", (code) => {
          managed.exitCode = code ?? undefined;
          emit(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
        });

        if (isBackground) {
          return { text: `Started background process ${terminalId}\nCommand: ${command}\nUse readTerminal to check output.` };
        } else {
          return new Promise<ToolResult>((resolve) => {
             let resolved = false;
             const timer = setTimeout(() => {
               if (!resolved) {
                 resolved = true;
                 resolve({ text: `Terminal command timed out after ${timeoutMs}ms.\nOutput so far:\n${trimToolOutput(managed.buffer)}` });
               }
             }, timeoutMs);

             child.on("close", (code) => {
               if (!resolved) {
                 resolved = true;
                 clearTimeout(timer);
                 resolve({ text: `Terminal process finished with code ${code}.\nOutput:\n${trimToolOutput(managed.buffer, maxToolOutputChars)}` });
               }
             });
          });
        }
      }
      case "readTerminal": {
        const id = getRequiredStringArg(args, "id");
        const mt = managedTerminals.get(id);
        if (!mt) {
          return { text: `Error: Terminal ${id} not found or already closed.` };
        }
        const output = mt.buffer;
        mt.buffer = ""; 
        const status = mt.exitCode !== undefined ? `Closed (code ${mt.exitCode})` : "Running";
        return { text: `[Status: ${status}]\nOutput:\n${trimToolOutput(output, maxToolOutputChars)}` };
      }
      case "sendTerminalInput": {
        const id = getRequiredStringArg(args, "id");
        const textToInput = getRequiredStringArg(args, "text");
        const mt = managedTerminals.get(id);
        if (!mt) {
          return { text: `Error: Terminal ${id} not found.` };
        }
        if (mt.process.stdin) {
          mt.process.stdin.write(textToInput);
          return { text: `Sent input to ${id}. Use readTerminal to see response.` };
        } else {
          return { text: `Error: Terminal ${id} does not have an open stdin.` };
        }
      }
      default:
        return { text: `Error: Unknown tool ${name}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `Error executing ${name}: ${message}` };
  }
}
