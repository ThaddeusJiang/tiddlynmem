#!/usr/bin/env nub

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";

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
  assertSavedPlanMatches,
  discardSavedPlan,
  loadSavedPlan,
  optionsFromSavedPlan,
  savePlan,
  SAVED_PLAN_RELATIVE_PATH,
  type SavedPlan,
} from "./plan.ts";
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

interface ResultEntry {
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

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;

const help = `Usage: tiddlynmem plan [options]
       tiddlynmem apply

Run this command from a TiddlyWiki root directory. It converts that Wiki's
tiddlers to Markdown and imports them into Nowledge Mem. The default command
is plan. Tiddlers tagged $:/NowledgeMem are skipped.

Commands:
  plan                    Preview and save an execution plan. Default.
  apply                   Apply the saved plan with no additional options.

Plan options:
  --limit <count>         Stop after this many ready tiddlers.
  --jobs <count>          Set concurrent Memory API writes. Default: 4.
  --space-id <id>         Set the Nowledge Mem space. Default: default.
  --tag <tag>             Only process tiddlers with this exact tag.
  --wiki-id <id>          Set a stable, portable identity for this Wiki.
  --include-sensitive     Include tiddlers with sensitive title terms.
  --api-url <url>         Override NMEM_API_URL and the local API default.

Global options:
  -h, --help              Show this help.
  -V, --version           Show the installed tiddlynmem version.
`;

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

function sanitizeTerminalText(value: string): string {
  return value.replace(TERMINAL_CONTROL_PATTERN, (character) => {
    switch (character) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

function formatSkippedSummary(skipped: Record<SkipReason, number>): string {
  const reasons = Object.entries(skipped).filter(([, count]) => count > 0);
  const total = reasons.reduce((sum, [, count]) => sum + count, 0);
  if (reasons.length === 0) {
    return "Skipped: 0";
  }
  return `Skipped: ${total} (${reasons
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ")})`;
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

function formatResultEntries(entries: ResultEntry[]): string {
  const lines = ["Tiddlers:"];
  if (entries.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  for (const entry of entries) {
    lines.push(
      `- [${sanitizeTerminalText(entry.status)}] ${sanitizeTerminalText(entry.title)}`,
    );
    lines.push(`  Source: ${sanitizeTerminalText(entry.sourceWiki)}`);
    lines.push(
      `  Tags: ${
        entry.tags.length > 0
          ? entry.tags.map(sanitizeTerminalText).join(", ")
          : "(none)"
      }`,
    );
    if (entry.id) {
      lines.push(`  ID: ${sanitizeTerminalText(entry.id)}`);
    }
    if (entry.sourceTag) {
      lines.push(`  Source tag: ${sanitizeTerminalText(entry.sourceTag)}`);
    }
    if (entry.warnings && entry.warnings.length > 0) {
      lines.push(
        `  Warnings: ${entry.warnings.map(sanitizeTerminalText).join("; ")}`,
      );
    }
    if (entry.error) {
      lines.push(`  Error: ${sanitizeTerminalText(entry.error)}`);
    }
  }
  return lines.join("\n");
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

  let options = parseArgs(rawArgs);
  const applying = options.command === "apply";
  const wikiPaths = [resolve(process.cwd())];

  for (const wikiPath of wikiPaths) {
    await assertWikiPath(wikiPath);
  }
  let savedPlan: SavedPlan | undefined;
  if (applying) {
    savedPlan = await loadSavedPlan(wikiPaths[0]!, packageVersion);
    options = optionsFromSavedPlan(savedPlan);
  } else {
    await discardSavedPlan(wikiPaths[0]!);
    options.apiUrl = resolveNmemApiUrl(options.apiUrl);
  }
  const wikiId = resolveWikiId(wikiPaths[0]!, options.wikiId);
  options.wikiId = wikiId;

  const entries: ResultEntry[] = [];
  const summary = newSummary();
  const memories: MemoryCandidate[] = [];
  const entriesById = new Map<string, ResultEntry>();

  for (const wikiPath of wikiPaths) {
    if (memories.length >= options.limit) {
      break;
    }
    const sourceWiki = basename(wikiPath);
    process.stdout.write(`Loading ${sanitizeTerminalText(sourceWiki)}...\n`);
    const { diagnostics, records } = await loadWiki(wikiPath, {
      includeSensitive: options.includeSensitive,
      tag: options.tag,
    });
    for (const message of diagnostics) {
      process.stderr.write(
        `TiddlyWiki [${sanitizeTerminalText(sourceWiki)}]: ${sanitizeTerminalText(message)}\n`,
      );
    }

    for (const tiddler of records) {
      if (memories.length >= options.limit) {
        break;
      }
      const tags = parseTagString(tiddler.tags);
      if (options.tag && !tags.includes(options.tag)) {
        continue;
      }
      summary.scanned += 1;
      const classification = classifyTiddler(tiddler, {
        includeSensitive: options.includeSensitive,
      });
      if (classification !== "ready") {
        summary.skipped[classification] += 1;
        entries.push({
          sourceWiki,
          status: `skipped:${classification}`,
          tags,
          title: tiddler.title,
        });
        continue;
      }
      if (tiddler.renderError) {
        summary.failed += 1;
        entries.push({
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
        summary.failed += 1;
        entries.push({
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
      summary.warnings += warnings.length;
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
        summary.failed += 1;
        entries.push({
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
      summary.ready += 1;
      const entry: ResultEntry = {
        id: memory.id,
        sourceWiki,
        status: "ready",
        tags,
        title: memory.title,
        warnings,
      };
      entries.push(entry);
      entriesById.set(memory.id, entry);
    }
  }

  if (applying) {
    if (summary.failed > 0) {
      throw new Error(
        'The TiddlyWiki changed after planning. Run "tiddlynmem plan" again before applying.',
      );
    }
    assertSavedPlanMatches(savedPlan!, memories);
  } else if (summary.failed === 0) {
    await savePlan({
      memories,
      options,
      packageVersion,
      wikiPath: wikiPaths[0]!,
    });
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
          throw new Error(`Missing result entry for memory ${memory.id}.`);
        }
        entry.status = "failed:preflight";
        entry.error = message;
        summary.failed += 1;
      }
    }
  }

  if (applying && nmemApiUrl) {
    process.stdout.write(`Importing ${memories.length} memories...\n`);
    const importedTitles: string[] = [];
    await runPool(memories, options.jobs, async (memory) => {
      const entry = entriesById.get(memory.id);
      if (!entry) {
        throw new Error(`Missing result entry for memory ${memory.id}.`);
      }
      try {
        await addMemory(memory, {
          apiUrl: nmemApiUrl,
          spaceId: options.spaceId,
        });
        entry.status = "imported";
        summary.imported += 1;
        importedTitles.push(memory.title);
      } catch (error) {
        entry.status = "failed:import";
        entry.error = error instanceof Error ? error.message : String(error);
        summary.failed += 1;
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
            throw new Error(`Missing result entry for tiddler ${result.title}.`);
          }
          entry.sourceTag = result.status;
          if (result.status === "failed") {
            entry.status = "imported:tag-failed";
            entry.error = `Memory imported, but source tagging failed: ${result.error ?? "Unknown error"}`;
            summary.failed += 1;
          } else {
            summary.tagged += 1;
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
            summary.failed += 1;
          }
        }
      }
    }
  }

  process.stdout.write(
    [
      `Mode: ${options.command}`,
      formatResultEntries(entries),
      `Scanned: ${summary.scanned}`,
      `Ready: ${summary.ready}`,
      formatSkippedSummary(summary.skipped),
      `Imported: ${summary.imported}`,
      `Tagged: ${summary.tagged}`,
      `Failed: ${summary.failed}`,
      `Warnings: ${summary.warnings}`,
      ...(!applying && summary.failed === 0
        ? [`Saved plan: ${SAVED_PLAN_RELATIVE_PATH}`]
        : []),
      "",
    ].join("\n"),
  );

  if (summary.failed > 0) {
    process.exitCode = 1;
  } else if (applying) {
    try {
      await discardSavedPlan(wikiPaths[0]!);
    } catch (error) {
      process.stderr.write(
        `Warning: unable to remove the saved plan: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}\n`,
      );
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exitCode = 1;
});
