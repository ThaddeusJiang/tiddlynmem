import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryContent,
  classifyTiddler,
  findMediaReferences,
  htmlToMarkdown,
  isSensitiveTitle,
  memoryIdFromUri,
  memoryUri,
  NOWLEDGE_MEM_TAG,
  parseTagString,
  resolveWikiId,
  sanitizeMarkdownMedia,
  shouldImportTiddler,
  stableMemoryId,
  toIsoTimestamp,
} from "../src/core.ts";

test("parseTagString keeps bracketed tags together", () => {
  assert.deepEqual(
    parseTagString("Tech [[local first data stack]] done"),
    ["Tech", "local first data stack", "done"],
  );
});

test("shouldImportTiddler excludes system, draft, empty, imported, and sensitive tiddlers", () => {
  assert.equal(shouldImportTiddler({ title: "$:/Config", text: "x" }), false);
  assert.equal(shouldImportTiddler({ title: "Draft", text: "x", draftOf: "Old" }), false);
  assert.equal(shouldImportTiddler({ title: "Empty", text: "  " }), false);
  assert.equal(
    shouldImportTiddler({
      tags: ["existing", NOWLEDGE_MEM_TAG],
      text: "x",
      title: "Imported",
    }),
    false,
  );
  assert.equal(shouldImportTiddler({ title: "GitHub token", text: "x" }), false);
  assert.equal(
    shouldImportTiddler(
      { title: "GitHub token", text: "x" },
      { includeSensitive: true },
    ),
    true,
  );
});

test("classifyTiddler returns a stable skip reason", () => {
  assert.equal(classifyTiddler({ title: "$:/Config", text: "x" }), "system");
  assert.equal(classifyTiddler({ title: "Draft", text: "x", draftTitle: "New" }), "draft");
  assert.equal(classifyTiddler({ title: "Empty", text: "" }), "empty");
  const imported = {
    tags: `existing ${NOWLEDGE_MEM_TAG}`,
    text: "x",
    title: "Imported",
  };
  assert.equal(classifyTiddler(imported), "imported");
  assert.equal(
    classifyTiddler(imported, { includeImported: true }),
    "ready",
  );
  assert.equal(
    classifyTiddler({ title: "Image", text: "x", type: "image/png" }),
    "unsupported_type",
  );
  assert.equal(classifyTiddler({ title: "API key", text: "x" }), "sensitive");
  assert.equal(classifyTiddler({ title: "Note", text: "x" }), "ready");
});

test("isSensitiveTitle detects supported sensitive terms", () => {
  assert.equal(isSensitiveTitle("Database password"), true);
  assert.equal(isSensitiveTitle("生产环境密钥"), true);
  assert.equal(isSensitiveTitle("Markdown tips"), false);
});

test("resolveWikiId separates same-named Wiki directories", () => {
  const first = resolveWikiId("/notes/one/wiki");
  const same = resolveWikiId("/notes/one/wiki");
  const other = resolveWikiId("/notes/two/wiki");

  assert.match(first, /^wiki-[0-9a-f]{12}$/u);
  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.equal(resolveWikiId("/notes/one/wiki", "personal-notes"), "personal-notes");
});

test("Memory URIs preserve deterministic Memory IDs", () => {
  const id = "12345678-1234-5123-8123-123456789abc";

  assert.equal(memoryUri(id), `nowledgemem://memory/${id}`);
  assert.equal(memoryIdFromUri(memoryUri(id)), id);
  assert.equal(memoryIdFromUri("https://example.com/memory/invalid"), undefined);
});

test("stableMemoryId is stable and separates Wiki identities", () => {
  const first = stableMemoryId("myblog-a1b2c3", "Same title");
  const second = stableMemoryId("myblog-a1b2c3", "Same title");
  const other = stableMemoryId("myblog-d4e5f6", "Same title");

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test("toIsoTimestamp converts a TiddlyWiki timestamp", () => {
  assert.equal(toIsoTimestamp("20250810125715658"), "2025-08-10T12:57:15.658Z");
  assert.equal(toIsoTimestamp(""), "");
  assert.equal(toIsoTimestamp(new Date(Number.NaN)), "");
});

test("htmlToMarkdown converts common TiddlyWiki output to GFM", () => {
  const html = [
    "<h2>Install</h2>",
    '<p>See <a class="tc-tiddlylink" href="#HelloThere">Hello</a>.</p>',
    "<pre><code>echo hi\n</code></pre>",
    "<table><thead><tr><th>Name</th><th>Value</th></tr></thead>",
    "<tbody><tr><td>A</td><td>B</td></tr></tbody></table>",
  ].join("");

  const markdown = htmlToMarkdown(html);

  assert.match(markdown, /^## Install/m);
  assert.match(markdown, /\[Hello\]\(#HelloThere\)/);
  assert.match(markdown, /```\necho hi\n```/);
  assert.match(markdown, /\| Name \| Value \|/);
});

test("findMediaReferences reports embedded and local images", () => {
  assert.deepEqual(
    findMediaReferences(
      '<img src="data:image/png;base64,abc"><img src="local image.png"><img src="https://example.com/a.png">',
    ),
    ["embedded:image/png", "local:local image.png"],
  );
});

test("sanitizeMarkdownMedia omits embedded images and reports local images", () => {
  const result = sanitizeMarkdownMedia(
    [
      "![Local](<local image.png>)",
      "![Embedded](data:image/png;base64,abc)",
      "![Remote](https://example.com/image.png)",
    ].join("\n"),
  );

  assert.equal(
    result.markdown,
    [
      "![Local](<local image.png>)",
      "[Embedded image: Embedded]",
      "![Remote](https://example.com/image.png)",
    ].join("\n"),
  );
  assert.deepEqual(result.warnings, [
    "local:local image.png",
    "embedded:image/png",
  ]);
  assert.doesNotMatch(result.markdown, /base64/u);
});

test("sanitizeMarkdownMedia handles reference and raw HTML images", () => {
  const result = sanitizeMarkdownMedia(
    [
      "![Referenced][asset]",
      "[asset]: data:image/svg+xml;base64,abc",
      '<img alt="Raw" src="data:image/gif;base64,abc">',
    ].join("\n"),
  );

  assert.match(result.markdown, /\[Embedded image: Referenced\]/u);
  assert.match(result.markdown, /\[Embedded image: Raw\]/u);
  assert.doesNotMatch(result.markdown, /base64/u);
  assert.deepEqual(result.warnings, [
    "embedded:image/svg+xml",
    "embedded:image/gif",
  ]);
});

test("sanitizeMarkdownMedia handles shortcut references and unquoted HTML sources", () => {
  const result = sanitizeMarkdownMedia(
    [
      "![Shortcut]",
      "[Shortcut]: data:image/png;base64,abc",
      "<img src=data:image/gif;base64,abc alt=Raw>",
    ].join("\n"),
  );

  assert.match(result.markdown, /\[Embedded image: Shortcut\]/u);
  assert.match(result.markdown, /\[Embedded image: Raw\]/u);
  assert.doesNotMatch(result.markdown, /base64/u);
  assert.deepEqual(result.warnings, [
    "embedded:image/png",
    "embedded:image/gif",
  ]);
});

test("buildMemoryContent keeps the Markdown body free of metadata front matter", () => {
  assert.equal(buildMemoryContent("\nBody\n"), "Body\n");
});
