import { tmpdir } from "node:os";
import { createRequire } from "node:module";

import {
  classifyTiddler,
  NMEM_DIGEST_FIELD,
  NMEM_URI_FIELD,
  parseTagString,
  toIsoTimestamp,
  type TiddlerRecord,
} from "./core.ts";
import {
  sourceFileDigest,
  type TiddlerFileInfo,
} from "./source-file.ts";

interface TiddlyWikiFields {
  [key: string]: unknown;
  created?: Date | string;
  modified?: Date | string;
  tags?: string | string[];
  text?: string;
  type?: string;
}

interface TiddlyWikiTiddler {
  fields: TiddlyWikiFields;
}

interface TiddlyWikiRuntime {
  boot: {
    argv: string[];
    boot(callback: () => void): void;
    files: Record<string, TiddlerFileInfo | undefined>;
  };
  wiki: {
    getTiddler(title: string): TiddlyWikiTiddler | undefined;
    getTiddlers(options: { includeSystem: boolean }): string[];
    renderTiddler(outputType: string, title: string): string;
  };
}

const require = createRequire(import.meta.url);
const { TiddlyWiki } = require("tiddlywiki/boot/boot.js") as {
  TiddlyWiki(): TiddlyWikiRuntime;
};
const wikiPath = process.argv[2];
const selectedTag = process.argv[3] ?? "";
const includeSensitive = process.argv[4] === "true";

if (!wikiPath) {
  throw new Error("A TiddlyWiki path is required.");
}

if (!process.send) {
  throw new Error("The TiddlyWiki worker requires a Node IPC channel.");
}

function sendRecords(records: TiddlerRecord[], index = 0): void {
  if (index >= records.length) {
    process.send!({ type: "done" }, (error) => {
      if (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
      } else {
        process.disconnect();
      }
    });
    return;
  }

  process.send!({ record: records[index], type: "record" }, (error) => {
    if (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    } else {
      sendRecords(records, index + 1);
    }
  });
}

async function collectRecords(
  tw: TiddlyWikiRuntime,
): Promise<TiddlerRecord[]> {
  const titles = tw.wiki.getTiddlers({ includeSystem: true });
  const records: TiddlerRecord[] = [];

  for (const title of titles) {
    const tiddler = tw.wiki.getTiddler(title);
    if (!tiddler) {
      continue;
    }

    const fields = tiddler.fields;
    if (
      selectedTag &&
      !parseTagString(
        typeof fields.tags === "string" || Array.isArray(fields.tags)
          ? fields.tags
          : [],
      ).includes(selectedTag)
    ) {
      continue;
    }
    const record: TiddlerRecord = {
      created: toIsoTimestamp(fields.created),
      draftOf:
        typeof fields["draft.of"] === "string" ? fields["draft.of"] : "",
      draftTitle:
        typeof fields["draft.title"] === "string"
          ? fields["draft.title"]
          : "",
      modified: toIsoTimestamp(fields.modified),
      nmemDigest:
        typeof fields[NMEM_DIGEST_FIELD] === "string"
          ? fields[NMEM_DIGEST_FIELD]
          : "",
      nmemUri:
        typeof fields[NMEM_URI_FIELD] === "string"
          ? fields[NMEM_URI_FIELD]
          : "",
      tags:
        typeof fields.tags === "string" || Array.isArray(fields.tags)
          ? fields.tags
          : [],
      text: typeof fields.text === "string" ? fields.text : "",
      title,
      type:
        typeof fields.type === "string"
          ? fields.type
          : "text/vnd.tiddlywiki",
    };
    const classification = classifyTiddler(record, {
      includeImported: true,
      includeSensitive,
    });

    if (classification === "ready") {
      const fileInfo = tw.boot.files[title];
      if (fileInfo) {
        record.sourceFileDigest = await sourceFileDigest(fileInfo);
      }
    }
    if (
      classification === "ready" &&
      (record.type === "text/vnd.tiddlywiki" || record.type === "")
    ) {
      try {
        record.html = tw.wiki.renderTiddler("text/html", title);
      } catch (error) {
        record.renderError =
          error instanceof Error ? error.message : String(error);
      }
    }

    records.push(record);
  }
  return records;
}

const tw = TiddlyWiki();
tw.boot.argv = [wikiPath, "--output", tmpdir()];
tw.boot.boot(() => {
  void collectRecords(tw).then(sendRecords).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
});
