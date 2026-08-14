import { spawn } from "node:child_process";

export interface MemoryInput {
  content: string;
  id: string;
  sourceWiki: string;
  title: string;
}

interface NmemStatus {
  api_url: string;
  mode: string;
  status: string;
  version: string;
}

interface AddMemoryOptions {
  attempts?: number;
  spaceId?: string;
}

interface CompatibilityOptions {
  allowRemote?: boolean;
}

interface ProcessOptions {
  input?: string;
}

interface ProcessResult {
  stderr: string;
  stdout: string;
}

function sourceLabel(sourceWiki: string): string {
  return `tiddlywiki-${sourceWiki
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;
}

export function buildNmemAddArgs(
  memory: Pick<MemoryInput, "id" | "sourceWiki" | "title">,
  options: Pick<AddMemoryOptions, "spaceId"> = {},
): string[] {
  const { spaceId = "default" } = options;
  return [
    "memories",
    "add",
    "--stdin",
    "--id",
    memory.id,
    "--json",
    "--title",
    memory.title,
    "--source",
    "tiddlywiki",
    "--space-id",
    spaceId,
    "--label",
    "tiddlywiki",
    "--label",
    sourceLabel(memory.sourceWiki),
  ];
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

export function assertCompatibleNmem(
  versionOutput: string,
  status: NmemStatus,
  options: CompatibilityOptions = {},
): void {
  const { allowRemote = false } = options;
  const cliVersion = versionOutput.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1];

  if (!cliVersion) {
    throw new Error("Unable to determine the installed nmem CLI version.");
  }
  if (cliVersion !== status.version) {
    throw new Error(
      `The nmem CLI (${cliVersion}) and service (${status.version}) versions do not match.`,
    );
  }
  if (status.status !== "ok") {
    throw new Error("Nowledge Mem is not healthy.");
  }
  if (
    !allowRemote &&
    (status.mode !== "local" || !isLoopbackUrl(status.api_url))
  ) {
    throw new Error(
      "Refusing to send tiddlers to a remote Nowledge Mem service. Use --allow-remote to continue.",
    );
  }
}

function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const { input = "" } = options;
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout });
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

export async function checkNmem(
  options: CompatibilityOptions = {},
): Promise<NmemStatus> {
  const version = await runProcess("nmem", ["--version"]);
  const statusResult = await runProcess("nmem", ["status", "--json"]);
  const status = JSON.parse(statusResult.stdout) as NmemStatus;
  assertCompatibleNmem(version.stdout, status, options);
  return status;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function addMemory(
  memory: MemoryInput,
  options: AddMemoryOptions = {},
): Promise<unknown> {
  const { attempts = 3, spaceId = "default" } = options;
  const args = buildNmemAddArgs(memory, { spaceId });
  let lastError: unknown = new Error("The nmem import failed.");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runProcess("nmem", args, { input: memory.content });
      return JSON.parse(result.stdout);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(250 * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
}
