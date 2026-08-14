#!/usr/bin/env nub

import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";

import {
  buildMemoryContent,
  classifyTiddler,
  findMediaReferences,
  htmlToMarkdown,
  parseTagString,
  resolveWikiId,
  sanitizeMarkdownMedia,
  stableMemoryId,
  toIsoTimestamp,
  type TiddlerClassification,
} from "./core.ts";
import {
  addMemory,
  checkNmemService,
  resolveNmemApiUrl,
  validateMemoryInput,
  type MemoryInput,
} from "./nmem.ts";
import { parseArgs } from "./options.ts";
import {
  NOWLEDGE_MEM_TAG,
  loadWiki,
  tagWikiTiddlers,
} from "./tiddlywiki.ts";

type SkipReason = Exclude<TiddlerClassification, "ready">;
const require = createRequire(import.meta.url);
const packageVersion = (require("../package.json") as { version: string }).version;

interface MemoryCandidate extends MemoryInput {
  warnings: string[];
}

interface ReportEntry {
  error?: string;
  id?: string;
  sourceWiki: string;
  sourceTag?: "added" | "already-present" | "failed";
  status: string;
  tags: string[];
  title: string;
  warnings?: string[];
}

interface ImportSummary {
  failed: number;
  imported: number;
  ready: number;
  scanned: number;
  skipped: Record<SkipReason, number>;
  tagged: number;
  warnings: number;
}

interface ImportReport {
  completedAt: string;
  entries: ReportEntry[];
  mode: "apply" | "plan";
  options: {
    includeSensitive: boolean;
    jobs: number;
    limit: number | null;
    spaceId: string;
    tag: string | null;
    wikiId: string;
  };
  startedAt: string;
  summary: ImportSummary;
  wikis: string[];
  workerDiagnostics: Array<{ message: string; sourceWiki: string }>;
}

const help = `Usage: tiddlynmem [plan|apply] [options]

Run this command from a TiddlyWiki root directory. It converts that Wiki's
tiddlers to Markdown and imports them into Nowledge Mem. The default command
is plan. Tiddlers tagged $:/NowledgeMem are skipped.

Commands:
  plan                    Preview changes without writing. Default.
  apply                   Write memories, then tag successful source tiddlers.

Options:
  --limit <count>         Stop after this many ready tiddlers.
  --jobs <count>          Set concurrent Memory API writes. Default: 4.
  --space-id <id>         Set the Nowledge Mem space. Default: default.
  --tag <tag>             Only process tiddlers with this exact tag.
  --wiki-id <id>          Set a stable, portable identity for this Wiki.
  --include-sensitive     Include tiddlers with sensitive title terms.
  --api-url <url>         Override NMEM_API_URL and the local API default.
  --preview-dir <path>    Write converted Markdown previews.
  --report <path>         Write the JSON report to this path.
  -h, --help              Show this help.
  -V, --version           Show the installed tiddlynmem version.
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
      imported: 0,
      sensitive: 0,
      system: 0,
      unsupported_type: 0,
    },
    tagged: 0,
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
  if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }

  const options = parseArgs(rawArgs);
  const applying = options.command === "apply";
  const wikiPaths = [resolve(process.cwd())];

  for (const wikiPath of wikiPaths) {
    await assertWikiPath(wikiPath);
  }
  const wikiId = resolveWikiId(wikiPaths[0]!, options.wikiId);

  const report: ImportReport = {
    completedAt: "",
    entries: [],
    mode: options.command,
    options: {
      includeSensitive: options.includeSensitive,
      jobs: options.jobs,
      limit: Number.isFinite(options.limit) ? options.limit : null,
      spaceId: options.spaceId,
      tag: options.tag || null,
      wikiId,
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
    const { diagnostics, records } = await loadWiki(wikiPath, {
      includeSensitive: options.includeSensitive,
      tag: options.tag,
    });
    report.workerDiagnostics.push(
      ...diagnostics.map((message) => ({ message, sourceWiki })),
    );

    for (const tiddler of records) {
      if (memories.length >= options.limit) {
        break;
      }
      const tags = parseTagString(tiddler.tags);
      if (options.tag && !tags.includes(options.tag)) {
        continue;
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
          tags,
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
          tags,
          title: tiddler.title,
        });
        continue;
      }

      const sourceBody =
        tiddler.type === "text/markdown" || tiddler.type === "text/plain"
          ? tiddler.text.trim()
          : htmlToMarkdown(tiddler.html ?? "");
      const markdownMedia =
        tiddler.type === "text/plain"
          ? { markdown: sourceBody, warnings: [] }
          : sanitizeMarkdownMedia(sourceBody);
      const body = markdownMedia.markdown;
      if (!body) {
        report.summary.failed += 1;
        report.entries.push({
          error: "The converted Markdown is empty.",
          sourceWiki,
          status: "failed:conversion",
          tags,
          title: tiddler.title,
        });
        continue;
      }

      const warnings = [
        ...new Set([
          ...findMediaReferences(tiddler.html ?? ""),
          ...markdownMedia.warnings,
        ]),
      ];
      report.summary.warnings += warnings.length;
      const memory = {
        content: buildMemoryContent(body),
        created: toIsoTimestamp(tiddler.created),
        id: stableMemoryId(wikiId, tiddler.title),
        modified: toIsoTimestamp(tiddler.modified),
        sourceWiki,
        tags,
        title: tiddler.title,
        warnings,
        wikiId,
      };
      const validationErrors = validateMemoryInput(memory);
      if (validationErrors.length > 0) {
        report.summary.failed += 1;
        report.entries.push({
          error: validationErrors.join(" "),
          id: memory.id,
          sourceWiki,
          status: "failed:validation",
          tags,
          title: memory.title,
          warnings,
        });
        continue;
      }
      memories.push(memory);
      report.summary.ready += 1;
      const entry: ReportEntry = {
        id: memory.id,
        sourceWiki,
        status: "ready",
        tags,
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

  let nmemApiUrl = "";
  if (applying && memories.length > 0) {
    try {
      const candidateApiUrl = resolveNmemApiUrl(options.apiUrl);
      await checkNmemService({
        apiUrl: candidateApiUrl,
      });
      nmemApiUrl = candidateApiUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const memory of memories) {
        const entry = entriesById.get(memory.id);
        if (!entry) {
          throw new Error(`Missing report entry for memory ${memory.id}.`);
        }
        entry.status = "failed:preflight";
        entry.error = message;
        report.summary.failed += 1;
      }
    }
  }

  if (applying && nmemApiUrl) {
    process.stdout.write(`Importing ${memories.length} memories...\n`);
    const importedTitles: string[] = [];
    await runPool(memories, options.jobs, async (memory) => {
      const entry = entriesById.get(memory.id);
      if (!entry) {
        throw new Error(`Missing report entry for memory ${memory.id}.`);
      }
      try {
        await addMemory(memory, {
          apiUrl: nmemApiUrl,
          spaceId: options.spaceId,
        });
        entry.status = "imported";
        report.summary.imported += 1;
        importedTitles.push(memory.title);
      } catch (error) {
        entry.status = "failed:import";
        entry.error = error instanceof Error ? error.message : String(error);
        report.summary.failed += 1;
      }
    });

    if (importedTitles.length > 0) {
      process.stdout.write(
        `Tagging ${importedTitles.length} source tiddlers with ${NOWLEDGE_MEM_TAG}...\n`,
      );
      const entriesByTitle = new Map(
        memories.map((memory) => [memory.title, entriesById.get(memory.id)]),
      );
      try {
        const tagResults = await tagWikiTiddlers(wikiPaths[0]!, importedTitles);
        for (const result of tagResults) {
          const entry = entriesByTitle.get(result.title);
          if (!entry) {
            throw new Error(`Missing report entry for tiddler ${result.title}.`);
          }
          entry.sourceTag = result.status;
          if (result.status === "failed") {
            entry.status = "imported:tag-failed";
            entry.error = `Memory imported, but source tagging failed: ${result.error ?? "Unknown error"}`;
            report.summary.failed += 1;
          } else {
            report.summary.tagged += 1;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const title of importedTitles) {
          const entry = entriesByTitle.get(title);
          if (entry && !entry.sourceTag) {
            entry.sourceTag = "failed";
            entry.status = "imported:tag-failed";
            entry.error = `Memory imported, but source tagging failed: ${message}`;
            report.summary.failed += 1;
          }
        }
      }
    }
  }

  report.completedAt = new Date().toISOString();
  const reportPath = resolve(
    options.reportPath ||
      resolve(
        process.cwd(),
        ".tiddlynmem",
        "reports",
        `${timestampForPath()}-${report.mode}.json`,
      ),
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    [
      `Mode: ${report.mode}`,
      `Scanned: ${report.summary.scanned}`,
      `Ready: ${report.summary.ready}`,
      `Imported: ${report.summary.imported}`,
      `Tagged: ${report.summary.tagged}`,
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
