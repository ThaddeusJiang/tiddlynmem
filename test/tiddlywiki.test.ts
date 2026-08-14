import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadWiki } from "../src/tiddlywiki.ts";

test("loadWiki transports multiline tiddlers without mixing logs", async () => {
  const fixture = resolve(
    fileURLToPath(new URL("./fixtures/wiki", import.meta.url)),
  );
  const { diagnostics, records } = await loadWiki(fixture);
  const record = records.find((item) => item.title === "Multiline");

  assert.ok(record);
  assert.equal(record.text.includes("First line.\n\n! Heading"), true);
  assert.ok(record.html);
  assert.match(record.html, /<h1 class="">Heading<\/h1>/u);
  assert.deepEqual(record.tags, ["Test", "long tag"]);
  assert.deepEqual(diagnostics, []);
});
