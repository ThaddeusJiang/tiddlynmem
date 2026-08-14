#!/usr/bin/env nub

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface CommandResult {
  stderr: string;
  stdout: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
) as { version: string };

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun({ stderr, stdout });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

const directVersion = await run("node", ["dist/cli.js", "--version"], {
  cwd: projectRoot,
});
if (directVersion.stdout.trim() !== packageJson.version) {
  throw new Error(
    `Unexpected generated CLI version: ${directVersion.stdout.trim()}`,
  );
}
await run("node", ["dist/cli.js", "--help"], { cwd: projectRoot });

const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tiddlynmem-package-"));
try {
  const packResult = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
    { cwd: projectRoot },
  );
  const packEntries = JSON.parse(packResult.stdout) as Array<{
    filename?: string;
  }>;
  const filename = packEntries[0]?.filename;
  if (!filename) {
    throw new Error("npm pack did not return a package filename.");
  }

  const installRoot = resolve(temporaryRoot, "install");
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefix",
      installRoot,
      resolve(temporaryRoot, filename),
    ],
    { cwd: temporaryRoot },
  );

  const installedCli = resolve(
    installRoot,
    "node_modules",
    ".bin",
    "tiddlynmem",
  );
  const installedVersion = await run(installedCli, ["--version"], {
    cwd: temporaryRoot,
  });
  if (installedVersion.stdout.trim() !== packageJson.version) {
    throw new Error(
      `Unexpected installed CLI version: ${installedVersion.stdout.trim()}`,
    );
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
