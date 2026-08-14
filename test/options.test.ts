import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/options.ts";

test("parseArgs uses safe defaults", () => {
  assert.deepEqual(parseArgs([]), {
    allowRemote: false,
    apply: false,
    includeSensitive: false,
    jobs: 4,
    limit: Number.POSITIVE_INFINITY,
    previewDir: "",
    reportPath: "",
    spaceId: "default",
  });
});

test("parseArgs ignores the package runner separator", () => {
  assert.equal(parseArgs(["--", "--limit", "10"]).limit, 10);
});

test("parseArgs accepts explicit import controls", () => {
  assert.deepEqual(
    parseArgs([
      "--apply",
      "--include-sensitive",
      "--allow-remote",
      "--jobs",
      "2",
      "--limit",
      "10",
      "--space-id",
      "personal",
      "--preview-dir",
      "/tmp/preview",
      "--report",
      "/tmp/report.json",
    ]),
    {
      allowRemote: true,
      apply: true,
      includeSensitive: true,
      jobs: 2,
      limit: 10,
      previewDir: "/tmp/preview",
      reportPath: "/tmp/report.json",
      spaceId: "personal",
    },
  );
});

test("parseArgs rejects invalid numbers and unknown options", () => {
  assert.throws(() => parseArgs(["--jobs", "0"]), /positive integer/u);
  assert.throws(() => parseArgs(["--limit", "no"]), /positive integer/u);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option/u);
  assert.throws(() => parseArgs(["--wiki", "/notes/one"]), /Unknown option/u);
});
