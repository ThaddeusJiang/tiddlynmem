import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCompatibleNmem,
  buildNmemAddArgs,
} from "../src/nmem.ts";

test("buildNmemAddArgs creates an upsert command without content", () => {
  const args = buildNmemAddArgs(
    {
      id: "8ea941d0-3d95-50e6-9c9d-dd10341f4f72",
      sourceWiki: "myblog",
      title: "Example",
    },
    { spaceId: "default" },
  );

  assert.deepEqual(args, [
    "memories",
    "add",
    "--stdin",
    "--id",
    "8ea941d0-3d95-50e6-9c9d-dd10341f4f72",
    "--json",
    "--title",
    "Example",
    "--source",
    "tiddlywiki",
    "--space-id",
    "default",
    "--label",
    "tiddlywiki",
    "--label",
    "tiddlywiki-myblog",
  ]);
  assert.equal(args.includes("content"), false);
});

test("assertCompatibleNmem accepts the installed matching local service", () => {
  assert.doesNotThrow(() =>
    assertCompatibleNmem("nmem 0.10.56", {
      api_url: "http://127.0.0.1:14242",
      mode: "local",
      status: "ok",
      version: "0.10.56",
    }),
  );
});

test("assertCompatibleNmem rejects a CLI and service version mismatch", () => {
  assert.throws(
    () =>
      assertCompatibleNmem("nmem 0.10.56", {
        api_url: "http://127.0.0.1:14242",
        mode: "local",
        status: "ok",
        version: "0.10.55",
      }),
    /versions do not match/u,
  );
});

test("assertCompatibleNmem rejects an unreadable CLI version", () => {
  assert.throws(
    () =>
      assertCompatibleNmem("nmem unknown", {
        api_url: "http://127.0.0.1:14242",
        mode: "local",
        status: "ok",
        version: "0.10.56",
      }),
    /determine the installed nmem CLI version/u,
  );
});

test("assertCompatibleNmem rejects a remote service by default", () => {
  const status = {
    api_url: "https://example.com",
    mode: "cloud",
    status: "ok",
    version: "0.10.56",
  };

  assert.throws(
    () => assertCompatibleNmem("nmem 0.10.56", status),
    /remote Nowledge Mem/u,
  );
  assert.doesNotThrow(() =>
    assertCompatibleNmem("nmem 0.10.56", status, { allowRemote: true }),
  );
});
