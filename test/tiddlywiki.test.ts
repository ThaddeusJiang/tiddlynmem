import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NOWLEDGE_MEM_TAG,
  loadWiki,
  tiddlyWikiWorkerEnvironment,
  tagWikiTiddlers,
} from "../src/tiddlywiki.ts";

const fixture = resolve(
  fileURLToPath(new URL("./fixtures/wiki", import.meta.url)),
);

test("TiddlyWiki workers do not inherit the Memory API key", () => {
  assert.deepEqual(
    tiddlyWikiWorkerEnvironment({
      LANG: "en_US.UTF-8",
      NMEM_API_KEY: "secret",
      PATH: "/usr/bin",
    }),
    {
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin",
    },
  );
});

test("loadWiki transports multiline tiddlers without mixing logs", async () => {
  const { diagnostics, records } = await loadWiki(fixture);
  const record = records.find((item) => item.title === "Multiline");

  assert.ok(record);
  assert.equal(record.text.includes("First line.\n\n! Heading"), true);
  assert.ok(record.html);
  assert.match(record.html, /<h1 class="">Heading<\/h1>/u);
  assert.deepEqual(record.tags, ["Test", "long tag"]);
  assert.deepEqual(diagnostics, []);
});

test("loadWiki filters by tag before returning records", async () => {
  const matching = await loadWiki(fixture, { tag: "long tag" });
  const missing = await loadWiki(fixture, { tag: "Missing" });

  assert.deepEqual(matching.records.map((record) => record.title), ["Multiline"]);
  assert.deepEqual(missing.records, []);
});

test("loadWiki renders only tiddlers that can be imported", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tiddlynmem-test-"));
  const wikiPath = resolve(temporaryRoot, "wiki");
  await cp(fixture, wikiPath, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(wikiPath, "tiddlers", "Draft.tid"),
      "title: Draft\ndraft.of: Original\ntype: text/vnd.tiddlywiki\n\nDraft body.\n",
      "utf8",
    ),
    writeFile(
      resolve(wikiPath, "tiddlers", "Imported.tid"),
      `title: Imported\ntags: ${NOWLEDGE_MEM_TAG}\ntype: text/vnd.tiddlywiki\n\nImported body.\n`,
      "utf8",
    ),
    writeFile(
      resolve(wikiPath, "tiddlers", "Sensitive.tid"),
      "title: API key notes\ntype: text/vnd.tiddlywiki\n\nSensitive body.\n",
      "utf8",
    ),
  ]);
  t.after(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  const defaultLoad = await loadWiki(wikiPath);
  const draft = defaultLoad.records.find((record) => record.title === "Draft");
  const imported = defaultLoad.records.find(
    (record) => record.title === "Imported",
  );
  const sensitive = defaultLoad.records.find(
    (record) => record.title === "API key notes",
  );
  assert.ok(draft);
  assert.ok(imported);
  assert.ok(sensitive);
  assert.equal(draft.html, undefined);
  assert.equal(imported.html, undefined);
  assert.equal(sensitive.html, undefined);

  const includedLoad = await loadWiki(wikiPath, { includeSensitive: true });
  const includedSensitive = includedLoad.records.find(
    (record) => record.title === "API key notes",
  );
  assert.ok(includedSensitive?.html);
});

test("tagWikiTiddlers appends the Nowledge Mem tag exactly once", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tiddlynmem-test-"));
  const wikiPath = resolve(temporaryRoot, "wiki");
  await cp(fixture, wikiPath, { recursive: true });
  t.after(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  const before = await loadWiki(wikiPath);
  const beforeRecord = before.records.find((item) => item.title === "Multiline");
  assert.ok(beforeRecord);

  const firstResult = await tagWikiTiddlers(wikiPath, ["Multiline"]);
  assert.deepEqual(firstResult, [{ status: "added", title: "Multiline" }]);

  const afterFirstWrite = await loadWiki(wikiPath);
  const taggedRecord = afterFirstWrite.records.find(
    (item) => item.title === "Multiline",
  );
  assert.ok(taggedRecord);
  assert.equal(taggedRecord.text, beforeRecord.text);
  assert.deepEqual(taggedRecord.tags, ["Test", "long tag", NOWLEDGE_MEM_TAG]);

  const secondResult = await tagWikiTiddlers(wikiPath, ["Multiline"]);
  assert.deepEqual(secondResult, [
    { status: "already-present", title: "Multiline" },
  ]);

  const afterSecondWrite = await loadWiki(wikiPath);
  const retaggedRecord = afterSecondWrite.records.find(
    (item) => item.title === "Multiline",
  );
  assert.ok(retaggedRecord);
  assert.equal(
    (Array.isArray(retaggedRecord.tags) ? retaggedRecord.tags : []).filter(
      (tag) => tag === NOWLEDGE_MEM_TAG,
    ).length,
    1,
  );
});

test("tagWikiTiddlers reports a missing source tiddler without writing", async () => {
  const result = await tagWikiTiddlers(fixture, ["Missing"]);

  assert.deepEqual(result, [
    {
      error: "The source tiddler no longer exists.",
      status: "failed",
      title: "Missing",
    },
  ]);
});

test("tagWikiTiddlers does not rewrite an unsupported source file", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tiddlynmem-test-"));
  const wikiPath = resolve(temporaryRoot, "wiki");
  const jsonPath = resolve(wikiPath, "tiddlers", "Shared.json");
  const json = `${JSON.stringify(
    [
      { text: "First body", title: "First", type: "text/plain" },
      { text: "Second body", title: "Second", type: "text/plain" },
    ],
    null,
    2,
  )}\n`;
  await cp(fixture, wikiPath, { recursive: true });
  await writeFile(jsonPath, json, "utf8");
  t.after(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  const result = await tagWikiTiddlers(wikiPath, ["First"]);

  assert.deepEqual(result, [
    {
      error: "Refusing to rewrite unsupported source file type application/json.",
      status: "failed",
      title: "First",
    },
  ]);
  assert.equal(await readFile(jsonPath, "utf8"), json);
});

test("tagWikiTiddlers preserves a Markdown file with a metadata sidecar", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tiddlynmem-test-"));
  const wikiPath = resolve(temporaryRoot, "wiki");
  const markdownPath = resolve(wikiPath, "tiddlers", "Markdown.md");
  const metadataPath = `${markdownPath}.meta`;
  const markdown = "# Heading\n\nOriginal body.\n";
  await cp(fixture, wikiPath, { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(
    metadataPath,
    "title: Markdown\ntags: Original\ntype: text/markdown\n",
    "utf8",
  );
  t.after(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  const result = await tagWikiTiddlers(wikiPath, ["Markdown"]);

  assert.deepEqual(result, [{ status: "added", title: "Markdown" }]);
  assert.equal(await readFile(markdownPath, "utf8"), markdown);
  const after = await loadWiki(wikiPath, { tag: NOWLEDGE_MEM_TAG });
  const record = after.records.find((item) => item.title === "Markdown");
  assert.ok(record);
  assert.deepEqual(record.tags, ["Original", NOWLEDGE_MEM_TAG]);
});
