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
  memoryIdFromUri,
  memoryUri,
  NOWLEDGE_MEM_TAG,
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
  memorySyncFingerprint,
  optionsFromSavedPlan,
  savePlan,
  SAVED_PLAN_RELATIVE_PATH,
  type SavedPlan,
} from "./plan.ts";
import { loadWiki, recordWikiSync } from "./tiddlywiki.ts";

type SkipReason = Exclude<TiddlerClassification, "ready"> | "unchanged";
type SyncAction = "create" | "migrate" | "update";
const require = createRequire(import.meta.url);
const packageVersion = (require("../package.json") as { version: string }).version;

interface MemoryCandidate extends MemoryInput {
  action: SyncAction;
  fingerprint: string;
  warnings: string[];
}

interface ResultEntry {
  error?: string;
  id?: string;
  sourceWiki: string;
  sourceSync?: "already-current" | "failed" | "written";
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
  recorded: number;
  warnings: number;
}

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;

const help = `Usage: tiddlynmem plan [options]
       tiddlynmem apply

Run this command from a TiddlyWiki root directory. It converts that Wiki's
tiddlers to Markdown and imports them into Nowledge Mem. The default command
is plan. Synced tiddlers are updated when their content or mapped metadata changes.

Commands:
  plan                    Preview and save an execution plan. Default.
  apply                   Apply the saved plan with no additional options.

Plan options:
  --limit <count>         Stop after this many create, migrate, or update actions.
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
      unchanged: 0,
      unsupported_type: 0,
    },
    recorded: 0,
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
    if (entry.sourceSync) {
      lines.push(`  Source sync: ${sanitizeTerminalText(entry.sourceSync)}`);
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
  const scannedMemories: MemoryInput[] = [];
  const entriesById = new Map<string, ResultEntry>();
  const plannedMemoryIds = new Set(
    savedPlan?.memories.map((memory) => memory.id) ?? [],
  );
  const planReachedLimit =
    applying &&
    Number.isFinite(options.limit) &&
    plannedMemoryIds.size === options.limit;
  const seenMemoryIds = new Map<string, string>();
  let hasUnplannedAction = false;

  for (const wikiPath of wikiPaths) {
    if (!applying && memories.length >= options.limit) {
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
      if (!applying && memories.length >= options.limit) {
        break;
      }
      const sourceTags = parseTagString(tiddler.tags);
      if (options.tag && !sourceTags.includes(options.tag)) {
        continue;
      }
      summary.scanned += 1;
      const classification = classifyTiddler(tiddler, {
        includeImported: true,
        includeSensitive: options.includeSensitive,
      });
      if (classification !== "ready") {
        summary.skipped[classification] += 1;
        entries.push({
          sourceWiki,
          status: `skipped:${classification}`,
          tags: sourceTags,
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
          tags: sourceTags,
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
          tags: sourceTags,
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
      const storedMemoryId = tiddler.nmemUri
        ? memoryIdFromUri(tiddler.nmemUri)
        : undefined;
      if (tiddler.nmemUri && !storedMemoryId) {
        summary.failed += 1;
        entries.push({
          error: `Invalid nmem-uri field: ${tiddler.nmemUri}`,
          sourceWiki,
          status: "failed:sync-metadata",
          tags: sourceTags,
          title: tiddler.title,
          warnings,
        });
        continue;
      }
      if (!tiddler.nmemUri && tiddler.nmemSyncFingerprint) {
        summary.failed += 1;
        entries.push({
          error: "The nmem-sync-fingerprint field exists without nmem-uri.",
          sourceWiki,
          status: "failed:sync-metadata",
          tags: sourceTags,
          title: tiddler.title,
          warnings,
        });
        continue;
      }

      const memory: MemoryInput = {
        content: buildMemoryContent(body),
        created: toIsoTimestamp(tiddler.created),
        id: storedMemoryId ?? stableMemoryId(wikiId, tiddler.title),
        modified: toIsoTimestamp(tiddler.modified),
        sourceWiki,
        tags: sourceTags.filter((tag) => tag !== NOWLEDGE_MEM_TAG),
        title: tiddler.title,
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
          tags: sourceTags,
          title: memory.title,
          warnings,
        });
        continue;
      }
      const previousTitle = seenMemoryIds.get(memory.id);
      if (previousTitle) {
        summary.failed += 1;
        entries.push({
          error: `Memory ID is already linked to tiddler ${previousTitle}.`,
          id: memory.id,
          sourceWiki,
          status: "failed:sync-metadata",
          tags: sourceTags,
          title: memory.title,
          warnings,
        });
        continue;
      }
      seenMemoryIds.set(memory.id, memory.title);

      const fingerprint = memorySyncFingerprint(memory, {
        apiUrl: options.apiUrl,
        spaceId: options.spaceId,
      });
      scannedMemories.push(memory);
      const hasMarker = sourceTags.includes(NOWLEDGE_MEM_TAG);
      const unchanged =
        hasMarker &&
        Boolean(tiddler.nmemUri) &&
        tiddler.nmemSyncFingerprint === fingerprint;
      if (applying && !plannedMemoryIds.has(memory.id) && !unchanged) {
        if (planReachedLimit) {
          summary.scanned -= 1;
          summary.warnings -= warnings.length;
        } else {
          hasUnplannedAction = true;
        }
        continue;
      }
      if (unchanged) {
        summary.skipped.unchanged += 1;
        entries.push({
          id: memory.id,
          sourceWiki,
          status: "skipped:unchanged",
          tags: sourceTags,
          title: memory.title,
          warnings,
        });
        continue;
      }

      const action: SyncAction =
        !tiddler.nmemUri || !tiddler.nmemSyncFingerprint || !hasMarker
          ? hasMarker || Boolean(tiddler.nmemUri)
            ? "migrate"
            : "create"
          : "update";
      const candidate: MemoryCandidate = {
        ...memory,
        action,
        fingerprint,
        warnings,
      };
      memories.push(candidate);
      summary.ready += 1;
      const entry: ResultEntry = {
        id: memory.id,
        sourceWiki,
        status: `ready:${action}`,
        tags: sourceTags,
        title: memory.title,
        warnings,
      };
      entries.push(entry);
      entriesById.set(memory.id, entry);
    }
  }

  if (applying) {
    if (summary.failed > 0 || hasUnplannedAction) {
      throw new Error(
        'The TiddlyWiki changed after planning. Run "tiddlynmem plan" again before applying.',
      );
    }
    assertSavedPlanMatches(savedPlan!, scannedMemories);
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
    const importedRecords: Array<{
      fingerprint: string;
      title: string;
      uri: string;
    }> = [];
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
        entry.status = `imported:${memory.action}`;
        summary.imported += 1;
        importedRecords.push({
          fingerprint: memory.fingerprint,
          title: memory.title,
          uri: memoryUri(memory.id),
        });
      } catch (error) {
        entry.status = "failed:import";
        entry.error = error instanceof Error ? error.message : String(error);
        summary.failed += 1;
      }
    });

    if (importedRecords.length > 0) {
      process.stdout.write(
        `Recording sync state for ${importedRecords.length} source tiddlers...\n`,
      );
      const entriesByTitle = new Map(
        memories.map((memory) => [memory.title, entriesById.get(memory.id)]),
      );
      try {
        const syncResults = await recordWikiSync(
          wikiPaths[0]!,
          importedRecords,
        );
        for (const result of syncResults) {
          const entry = entriesByTitle.get(result.title);
          if (!entry) {
            throw new Error(`Missing result entry for tiddler ${result.title}.`);
          }
          entry.sourceSync = result.status;
          if (result.status === "failed") {
            entry.status = "imported:writeback-failed";
            entry.error = `Memory imported, but source sync writeback failed: ${result.error ?? "Unknown error"}`;
            summary.failed += 1;
          } else {
            summary.recorded += 1;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const record of importedRecords) {
          const entry = entriesByTitle.get(record.title);
          if (entry && !entry.sourceSync) {
            entry.sourceSync = "failed";
            entry.status = "imported:writeback-failed";
            entry.error = `Memory imported, but source sync writeback failed: ${message}`;
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
      `Recorded: ${summary.recorded}`,
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
