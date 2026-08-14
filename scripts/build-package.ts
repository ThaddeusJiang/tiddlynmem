#!/usr/bin/env nub

import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "dist");
const cliPath = resolve(outputDirectory, "cli.js");

function run(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(new Error(`${command} exited with code ${code}.`));
      }
    });
  });
}

await rm(outputDirectory, { force: true, recursive: true });
await run("tsc", ["--project", "tsconfig.build.json"]);

const nubShebang = "#!/usr/bin/env nub";
const nodeShebang = "#!/usr/bin/env node";
const cli = await readFile(cliPath, "utf8");
if (!cli.startsWith(nubShebang)) {
  throw new Error(`Expected ${cliPath} to start with the Nub shebang.`);
}

await writeFile(cliPath, `${nodeShebang}${cli.slice(nubShebang.length)}`, "utf8");
await chmod(cliPath, 0o755);
