import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryMarkdown,
  classifyTiddler,
  findMediaReferences,
  htmlToMarkdown,
  isSensitiveTitle,
  parseTagString,
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

test("shouldImportTiddler excludes system, draft, empty, and sensitive tiddlers", () => {
  assert.equal(shouldImportTiddler({ title: "$:/Config", text: "x" }), false);
  assert.equal(shouldImportTiddler({ title: "Draft", text: "x", draftOf: "Old" }), false);
  assert.equal(shouldImportTiddler({ title: "Empty", text: "  " }), false);
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

test("stableMemoryId is stable and separates source wikis", () => {
  const first = stableMemoryId("myblog", "Same title");
  const second = stableMemoryId("myblog", "Same title");
  const other = stableMemoryId("life-blog", "Same title");

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

test("buildMemoryMarkdown adds source metadata", () => {
  const markdown = buildMemoryMarkdown(
    {
      title: "Example",
      tags: ["Tech", "long tag"],
      created: "20250810125715658",
      modified: "20250812071535863",
      text: "Body",
    },
    "myblog",
    "Body",
  );

  assert.match(markdown, /tiddlywiki_source: "myblog"/);
  assert.match(markdown, /tiddlywiki_title: "Example"/);
  assert.match(markdown, /tiddlywiki_tags: \["Tech","long tag"\]/);
  assert.match(markdown, /tiddlywiki_created: "2025-08-10T12:57:15.658Z"/);
  assert.match(markdown, /\n---\n\nBody\n$/);
});
