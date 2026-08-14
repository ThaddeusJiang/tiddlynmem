import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { TiddlerRecord } from "./core.ts";

const workerPath = fileURLToPath(
  new URL("./tiddlywiki-worker.ts", import.meta.url),
);

export interface WikiLoadResult {
  diagnostics: string[];
  records: TiddlerRecord[];
}

interface WorkerMessage {
  record?: TiddlerRecord;
  type: "done" | "record";
}

function isWorkerMessage(message: unknown): message is WorkerMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message.type === "done" || message.type === "record")
  );
}

export function loadWiki(wikiPath: string): Promise<WikiLoadResult> {
  return new Promise<WikiLoadResult>((resolve, reject) => {
    const child = fork(workerPath, [wikiPath], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const records: TiddlerRecord[] = [];
    const diagnostics: string[] = [];
    let stderr = "";
    let completed = false;

    child.on("message", (message) => {
      if (!isWorkerMessage(message)) {
        return;
      }
      if (message.type === "record" && message.record) {
        records.push(message.record);
      } else if (message.type === "done") {
        completed = true;
      }
    });
    if (!child.stderr) {
      reject(new Error("The TiddlyWiki worker stderr pipe is unavailable."));
      return;
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      diagnostics.push(
        ...stderr
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      if (code === 0 && completed) {
        resolve({ diagnostics, records });
      } else {
        reject(
          new Error(
            `TiddlyWiki worker exited before completion with code ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}
