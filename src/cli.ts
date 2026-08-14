#!/usr/bin/env nub

import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMemoryMarkdown,
  classifyTiddler,
  findMediaReferences,
  htmlToMarkdown,
  stableMemoryId,
  type TiddlerClassification,
} from "./core.ts";
import { addMemory, checkNmem, type MemoryInput } from "./nmem.ts";
import { parseArgs } from "./options.ts";
import { loadWiki } from "./tiddlywiki.ts";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type SkipReason = Exclude<TiddlerClassification, "ready">;

interface MemoryCandidate extends MemoryInput {
  warnings: string[];
}

interface ReportEntry {
  error?: string;
  id?: string;
  sourceWiki: string;
  status: string;
  title: string;
  warnings?: string[];
}

interface ImportSummary {
  failed: number;
  imported: number;
  ready: number;
  scanned: number;
  skipped: Record<SkipReason, number>;
  warnings: number;
}

interface ImportReport {
  completedAt: string;
  entries: ReportEntry[];
  mode: "apply" | "dry-run";
  options: {
    allowRemote: boolean;
    includeSensitive: boolean;
    jobs: number;
    limit: number | null;
    spaceId: string;
  };
  startedAt: string;
  summary: ImportSummary;
  wikis: string[];
  workerDiagnostics: Array<{ message: string; sourceWiki: string }>;
}

const help = `Usage: nub /path/to/tiddlywiki-nmem-importer/src/cli.ts [options]

Run this command from a TiddlyWiki root directory. It converts that Wiki's
tiddlers to Markdown and upserts them into Nowledge Mem. The default mode is
a dry run.

Options:
  --apply                 Write memories to Nowledge Mem.
  --limit <count>         Stop after this many ready tiddlers.
  --jobs <count>          Set concurrent nmem writes. Default: 4.
  --space-id <id>         Set the Nowledge Mem space. Default: default.
  --include-sensitive     Include tiddlers with sensitive title terms.
  --allow-remote          Allow a non-local Nowledge Mem service.
  --preview-dir <path>    Write converted Markdown previews.
  --report <path>         Write the JSON report to this path.
  -h, --help              Show this help.
`;

function timestampForPath() {
  return new Date().toISOString().replaceAll(":", "-");
}

async function assertWikiPath(wikiPath: string): Promise<void> {
  const infoPath = resolve(wikiPath, "tiddlywiki.info");
  try {
    await access(infoPath, constants.R_OK);
  } catch (error) {
    throw new Error(
      `Current directory is not a TiddlyWiki root: ${infoPath} is missing or unreadable.`,
      { cause: error },
    );
  }
}

function newSummary(): ImportSummary {
  return {
    failed: 0,
    imported: 0,
    ready: 0,
    scanned: 0,
    skipped: {
      draft: 0,
      empty: 0,
      sensitive: 0,
      system: 0,
      unsupported_type: 0,
    },
    warnings: 0,
  };
}

async function writePreview(
  previewDir: string,
  memory: MemoryCandidate,
): Promise<void> {
  const directory = resolve(previewDir, memory.sourceWiki);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${memory.id}.md`), memory.content, "utf8");
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await task(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(help);
    return;
  }

  const options = parseArgs(rawArgs);
  const wikiPaths = [resolve(process.cwd())];

  for (const wikiPath of wikiPaths) {
    await assertWikiPath(wikiPath);
  }
  if (options.apply) {
    await checkNmem({ allowRemote: options.allowRemote });
  }

  const report: ImportReport = {
    completedAt: "",
    entries: [],
    mode: options.apply ? "apply" : "dry-run",
    options: {
      allowRemote: options.allowRemote,
      includeSensitive: options.includeSensitive,
      jobs: options.jobs,
      limit: Number.isFinite(options.limit) ? options.limit : null,
      spaceId: options.spaceId,
    },
    startedAt: new Date().toISOString(),
    summary: newSummary(),
    wikis: wikiPaths,
    workerDiagnostics: [],
  };
  const memories: MemoryCandidate[] = [];
  const entriesById = new Map<string, ReportEntry>();

  for (const wikiPath of wikiPaths) {
    if (memories.length >= options.limit) {
      break;
    }
    const sourceWiki = basename(wikiPath);
    process.stdout.write(`Loading ${sourceWiki}...\n`);
    const { diagnostics, records } = await loadWiki(wikiPath);
    report.workerDiagnostics.push(
      ...diagnostics.map((message) => ({ message, sourceWiki })),
    );

    for (const tiddler of records) {
      if (memories.length >= options.limit) {
        break;
      }
      report.summary.scanned += 1;
      const classification = classifyTiddler(tiddler, {
        includeSensitive: options.includeSensitive,
      });
      if (classification !== "ready") {
        report.summary.skipped[classification] += 1;
        report.entries.push({
          sourceWiki,
          status: `skipped:${classification}`,
          title: tiddler.title,
        });
        continue;
      }
      if (tiddler.renderError) {
        report.summary.failed += 1;
        report.entries.push({
          error: tiddler.renderError,
          sourceWiki,
          status: "failed:render",
          title: tiddler.title,
        });
        continue;
      }

      const body =
        tiddler.type === "text/markdown" || tiddler.type === "text/plain"
          ? tiddler.text.trim()
          : htmlToMarkdown(tiddler.html ?? "");
      if (!body) {
        report.summary.failed += 1;
        report.entries.push({
          error: "The converted Markdown is empty.",
          sourceWiki,
          status: "failed:conversion",
          title: tiddler.title,
        });
        continue;
      }

      const warnings = findMediaReferences(tiddler.html ?? "");
      report.summary.warnings += warnings.length;
      const memory = {
        content: buildMemoryMarkdown(tiddler, sourceWiki, body),
        id: stableMemoryId(sourceWiki, tiddler.title),
        sourceWiki,
        title: tiddler.title,
        warnings,
      };
      memories.push(memory);
      report.summary.ready += 1;
      const entry: ReportEntry = {
        id: memory.id,
        sourceWiki,
        status: "ready",
        title: memory.title,
        warnings,
      };
      report.entries.push(entry);
      entriesById.set(memory.id, entry);
      if (options.previewDir) {
        await writePreview(options.previewDir, memory);
      }
    }
  }

  if (options.apply) {
    process.stdout.write(`Importing ${memories.length} memories...\n`);
    await runPool(memories, options.jobs, async (memory) => {
      const entry = entriesById.get(memory.id);
      if (!entry) {
        throw new Error(`Missing report entry for memory ${memory.id}.`);
      }
      try {
        await addMemory(memory, { spaceId: options.spaceId });
        entry.status = "imported";
        report.summary.imported += 1;
      } catch (error) {
        entry.status = "failed:import";
        entry.error = error instanceof Error ? error.message : String(error);
        report.summary.failed += 1;
      }
    });
  }

  report.completedAt = new Date().toISOString();
  const reportPath = resolve(
    options.reportPath ||
      resolve(toolRoot, "reports", `${timestampForPath()}-${report.mode}.json`),
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    [
      `Mode: ${report.mode}`,
      `Scanned: ${report.summary.scanned}`,
      `Ready: ${report.summary.ready}`,
      `Imported: ${report.summary.imported}`,
      `Failed: ${report.summary.failed}`,
      `Warnings: ${report.summary.warnings}`,
      `Report: ${reportPath}`,
      "",
    ].join("\n"),
  );

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
