import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { NOWLEDGE_MEM_TAG, type TiddlerRecord } from "./core.ts";

const workerFile = import.meta.url.endsWith(".ts")
  ? "./tiddlywiki-worker.ts"
  : "./tiddlywiki-worker.js";
const workerPath = fileURLToPath(new URL(workerFile, import.meta.url));
const tagWorkerFile = import.meta.url.endsWith(".ts")
  ? "./tiddlywiki-tag-worker.ts"
  : "./tiddlywiki-tag-worker.js";
const tagWorkerPath = fileURLToPath(new URL(tagWorkerFile, import.meta.url));
const WIKI_WORKER_TIMEOUT_MS = 300_000;

export { NOWLEDGE_MEM_TAG } from "./core.ts";

export interface WikiLoadResult {
  diagnostics: string[];
  records: TiddlerRecord[];
}

export interface WikiLoadOptions {
  includeSensitive?: boolean;
  tag?: string;
  timeoutMs?: number;
}

interface WorkerMessage {
  record?: TiddlerRecord;
  type: "done" | "record";
}

export interface TiddlerTagResult {
  error?: string;
  status: "added" | "already-present" | "failed";
  title: string;
}

export function tiddlyWikiWorkerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.NMEM_API_KEY;
  return sanitized;
}

interface TagWorkerMessage extends Partial<TiddlerTagResult> {
  type: "done" | "ready" | "result";
}

function isWorkerMessage(message: unknown): message is WorkerMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message.type === "done" || message.type === "record")
  );
}

function isTagWorkerMessage(message: unknown): message is TagWorkerMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message.type === "done" ||
      message.type === "ready" ||
      message.type === "result")
  );
}

export function loadWiki(
  wikiPath: string,
  options: WikiLoadOptions = {},
): Promise<WikiLoadResult> {
  return new Promise<WikiLoadResult>((resolve, reject) => {
    const child = fork(
      workerPath,
      [wikiPath, options.tag ?? "", String(options.includeSensitive ?? false)],
      {
        env: tiddlyWikiWorkerEnvironment(),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const records: TiddlerRecord[] = [];
    const diagnostics: string[] = [];
    let stderr = "";
    let completed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const succeed = (result: WikiLoadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timeoutMs = options.timeoutMs ?? WIKI_WORKER_TIMEOUT_MS;
    timer = setTimeout(() => {
      fail(new Error(`TiddlyWiki worker timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

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
      fail(new Error("The TiddlyWiki worker stderr pipe is unavailable."));
      return;
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      diagnostics.push(
        ...stderr
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      if (code === 0 && completed) {
        succeed({ diagnostics, records });
      } else {
        fail(
          new Error(
            `TiddlyWiki worker exited before completion with code ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

export function tagWikiTiddlers(
  wikiPath: string,
  titles: string[],
  tag = NOWLEDGE_MEM_TAG,
): Promise<TiddlerTagResult[]> {
  if (titles.length === 0) {
    return Promise.resolve([]);
  }

  return new Promise<TiddlerTagResult[]>((resolve, reject) => {
    const child = fork(tagWorkerPath, [wikiPath], {
      env: tiddlyWikiWorkerEnvironment(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const results: TiddlerTagResult[] = [];
    let stderr = "";
    let completed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const succeed = (tagResults: TiddlerTagResult[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(tagResults);
    };
    timer = setTimeout(() => {
      fail(
        new Error(
          `TiddlyWiki tag worker timed out after ${WIKI_WORKER_TIMEOUT_MS}ms.`,
        ),
      );
    }, WIKI_WORKER_TIMEOUT_MS);

    child.on("message", (message) => {
      if (!isTagWorkerMessage(message)) {
        return;
      }
      if (message.type === "ready") {
        child.send({ tag, titles, type: "tag" });
      } else if (
        message.type === "result" &&
        typeof message.title === "string" &&
        (message.status === "added" ||
          message.status === "already-present" ||
          message.status === "failed")
      ) {
        results.push({
          ...(typeof message.error === "string"
            ? { error: message.error }
            : {}),
          status: message.status,
          title: message.title,
        });
      } else if (message.type === "done") {
        completed = true;
      }
    });
    if (!child.stderr) {
      fail(new Error("The TiddlyWiki tag worker stderr pipe is unavailable."));
      return;
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (code === 0 && completed && results.length === titles.length) {
        succeed(results);
      } else {
        fail(
          new Error(
            `TiddlyWiki tag worker exited before completion with code ${code}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}
