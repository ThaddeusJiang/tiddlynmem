import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stableMemoryId } from "../src/core.ts";
import { NOWLEDGE_MEM_TAG, loadWiki } from "../src/tiddlywiki.ts";

interface CommandResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveRun({ code, stderr, stdout });
    });
  });
}

test("help does not advertise a remote-service confirmation flag", async () => {
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const result = await run("nub", [cliPath, "--help"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /allow-remote/u);
});

test("apply tags a tiddler after its Memory import succeeds", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tiddlynmem-cli-test-"));
  const wikiPath = resolve(temporaryRoot, "wiki");
  const reportPath = resolve(temporaryRoot, "report.json");
  const failedReportPath = resolve(temporaryRoot, "failed-report.json");
  const malformedReportPath = resolve(temporaryRoot, "malformed-report.json");
  const preflightReportPath = resolve(temporaryRoot, "preflight-report.json");
  const secondReportPath = resolve(temporaryRoot, "second-report.json");
  const planReportPath = resolve(temporaryRoot, "plan-report.json");
  const tagReportPath = resolve(temporaryRoot, "tag-report.json");
  const fixture = fileURLToPath(new URL("./fixtures/wiki", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const memoryRequests: Array<Record<string, unknown>> = [];
  let healthRequests = 0;
  let healthResponseStatus = 200;
  let memoryResponseIncludesId = true;
  let memoryResponseStatus = 200;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      healthRequests += 1;
      response.writeHead(healthResponseStatus, {
        "Content-Type": "application/json",
      });
      response.end(
        healthResponseStatus === 200
          ? '{"services_ready":true,"status":"ok","version":"1.2.3"}'
          : '{"detail":"unavailable"}',
      );
      return;
    }
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    if (request.method !== "POST" || request.url !== "/memories") {
      response.writeHead(404).end();
      return;
    }
    const memoryRequest = JSON.parse(body) as Record<string, unknown>;
    memoryRequests.push(memoryRequest);
    response.writeHead(memoryResponseStatus, { "Content-Type": "application/json" });
    response.end(
      memoryResponseStatus === 200
        ? JSON.stringify({
            action: "created",
            memory: memoryResponseIncludesId ? { id: memoryRequest.id } : {},
          })
        : '{"detail":"rejected"}',
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const serverAddress = server.address();
  assert.ok(serverAddress && typeof serverAddress !== "string");
  const apiUrl = `http://127.0.0.1:${serverAddress.port}`;
  await cp(fixture, wikiPath, { recursive: true });
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  const tagResult = await run(
    "nub",
    [cliPath, "--tag", "long tag", "--report", tagReportPath],
    {
      cwd: wikiPath,
      env: process.env,
    },
  );

  assert.equal(tagResult.code, 0, tagResult.stderr);
  assert.match(tagResult.stdout, /Scanned: 1/u);
  assert.match(tagResult.stdout, /Ready: 1/u);
  const tagReport = JSON.parse(await readFile(tagReportPath, "utf8")) as {
    entries: Array<{ tags: string[]; title: string }>;
    mode: string;
    options: { tag: string | null };
  };
  assert.equal(tagReport.mode, "plan");
  assert.equal(tagReport.options.tag, "long tag");
  assert.deepEqual(
    tagReport.entries.map((item) => item.title),
    ["Multiline"],
  );
  assert.deepEqual(tagReport.entries[0]?.tags, ["Test", "long tag"]);
  assert.equal(memoryRequests.length, 0);
  assert.equal(healthRequests, 0);

  const planResult = await run(
    "nub",
    [
      cliPath,
      "plan",
      "--tag",
      "long tag",
      "--report",
      planReportPath,
    ],
    {
      cwd: wikiPath,
      env: process.env,
    },
  );

  assert.equal(planResult.code, 0, planResult.stderr);
  assert.match(planResult.stdout, /Mode: plan/u);
  assert.equal(memoryRequests.length, 0);
  assert.equal(healthRequests, 0);

  healthResponseStatus = 503;
  const preflightResult = await run(
    "nub",
    [
      cliPath,
      "apply",
      "--wiki-id",
      "fixture-wiki",
      "--report",
      preflightReportPath,
    ],
    {
      cwd: wikiPath,
      env: {
        ...process.env,
        NMEM_API_URL: apiUrl,
      },
    },
  );

  assert.equal(preflightResult.code, 1);
  assert.equal(memoryRequests.length, 0);
  const preflightReport = JSON.parse(
    await readFile(preflightReportPath, "utf8"),
  ) as {
    entries: Array<{ error?: string; status: string; title: string }>;
  };
  const preflightEntry = preflightReport.entries.find(
    (entry) => entry.title === "Multiline",
  );
  assert.equal(preflightEntry?.status, "failed:preflight");
  assert.match(preflightEntry?.error ?? "", /HTTP 503/u);

  healthResponseStatus = 200;

  memoryResponseIncludesId = false;
  const malformedResult = await run(
    "nub",
    [
      cliPath,
      "apply",
      "--wiki-id",
      "fixture-wiki",
      "--report",
      malformedReportPath,
    ],
    {
      cwd: wikiPath,
      env: {
        ...process.env,
        NMEM_API_URL: apiUrl,
      },
    },
  );

  assert.equal(malformedResult.code, 1);
  assert.equal(memoryRequests.length, 1);
  const malformedReport = JSON.parse(
    await readFile(malformedReportPath, "utf8"),
  ) as {
    entries: Array<{ error?: string; status: string; title: string }>;
  };
  const malformedEntry = malformedReport.entries.find(
    (item) => item.title === "Multiline",
  );
  assert.equal(malformedEntry?.status, "failed:import");
  assert.match(malformedEntry?.error ?? "", /valid Memory ID/u);
  const afterMalformedResponse = await loadWiki(wikiPath);
  const stillUntaggedRecord = afterMalformedResponse.records.find(
    (item) => item.title === "Multiline",
  );
  assert.ok(stillUntaggedRecord);
  assert.equal(
    (Array.isArray(stillUntaggedRecord.tags)
      ? stillUntaggedRecord.tags
      : []
    ).includes(NOWLEDGE_MEM_TAG),
    false,
  );

  memoryResponseIncludesId = true;
  memoryResponseStatus = 422;
  const failedResult = await run(
    "nub",
    [
      cliPath,
      "apply",
      "--wiki-id",
      "fixture-wiki",
      "--report",
      failedReportPath,
    ],
    {
      cwd: wikiPath,
      env: {
        ...process.env,
        NMEM_API_URL: apiUrl,
      },
    },
  );

  assert.equal(failedResult.code, 1);
  assert.equal(memoryRequests.length, 2);
  const failedReport = await readFile(failedReportPath, "utf8");
  assert.doesNotMatch(failedReport, /rejected/u);
  const afterFailedImport = await loadWiki(wikiPath);
  const untaggedRecord = afterFailedImport.records.find(
    (item) => item.title === "Multiline",
  );
  assert.ok(untaggedRecord);
  assert.equal(
    (Array.isArray(untaggedRecord.tags) ? untaggedRecord.tags : []).includes(
      NOWLEDGE_MEM_TAG,
    ),
    false,
  );

  memoryResponseStatus = 200;
  const result = await run(
    "nub",
    [
      cliPath,
      "apply",
      "--api-url",
      apiUrl,
      "--wiki-id",
      "fixture-wiki",
      "--report",
      reportPath,
    ],
    {
      cwd: wikiPath,
      env: {
        ...process.env,
        NMEM_API_URL: "http://127.0.0.1:1",
      },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Imported: 1/u);
  assert.match(result.stdout, /Tagged: 1/u);
  assert.equal(memoryRequests.length, 3);
  assert.deepEqual(memoryRequests[2], {
    content: [
      "First line.",
      "",
      "# Heading",
      "",
      "Second line with [a link](#Target).",
      "",
    ].join("\n"),
    id: stableMemoryId("fixture-wiki", "Multiline"),
    labels: ["tiddlywiki", "tiddlywiki-wiki", "Test", "long tag"],
    metadata: {
      tiddlywiki_created: "2025-08-10T12:57:15.658Z",
      tiddlywiki_modified: "2025-08-12T07:15:35.863Z",
      tiddlywiki_source: "wiki",
      tiddlywiki_tags: ["Test", "long tag"],
      tiddlywiki_title: "Multiline",
      tiddlywiki_wiki_id: "fixture-wiki",
    },
    source: "tiddlywiki",
    source_app: "tiddlynmem",
    space_id: "default",
    title: "Multiline",
  });

  const { records } = await loadWiki(wikiPath);
  const record = records.find((item) => item.title === "Multiline");
  assert.ok(record);
  assert.deepEqual(record.tags, ["Test", "long tag", NOWLEDGE_MEM_TAG]);

  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    entries: Array<{
      sourceTag?: string;
      status: string;
      tags: string[];
      title: string;
    }>;
    mode: string;
    options: { wikiId: string };
  };
  assert.equal(report.mode, "apply");
  assert.equal(report.options.wikiId, "fixture-wiki");
  const entry = report.entries.find((item) => item.title === "Multiline");
  assert.ok(entry);
  assert.equal(entry.status, "imported");
  assert.equal(entry.sourceTag, "added");
  assert.deepEqual(entry.tags, ["Test", "long tag"]);

  const secondResult = await run(
    "nub",
    [
      cliPath,
      "apply",
      "--wiki-id",
      "fixture-wiki",
      "--report",
      secondReportPath,
    ],
    {
      cwd: wikiPath,
      env: {
        ...process.env,
        NMEM_API_URL: apiUrl,
      },
    },
  );

  assert.equal(secondResult.code, 0, secondResult.stderr);
  assert.match(secondResult.stdout, /Ready: 0/u);
  assert.match(secondResult.stdout, /Imported: 0/u);
  assert.match(secondResult.stdout, /Tagged: 0/u);
  assert.equal(memoryRequests.length, 3);
  assert.equal(healthRequests, 4);
  const secondReport = JSON.parse(
    await readFile(secondReportPath, "utf8"),
  ) as {
    entries: Array<{ status: string; tags: string[]; title: string }>;
  };
  const secondEntry = secondReport.entries.find(
    (item) => item.title === "Multiline",
  );
  assert.equal(secondEntry?.status, "skipped:imported");
  assert.deepEqual(secondEntry?.tags, ["Test", "long tag", NOWLEDGE_MEM_TAG]);
});

test("CLI reports its package version outside a Wiki", async () => {
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));

  const result = await run("nub", [cliPath, "--version"], {
    cwd: projectRoot,
    env: process.env,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "0.1.0\n");
});

test("plan sanitizes Markdown media and reports native API limits", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "tiddlynmem-cli-test-"));
  const wikiPath = resolve(temporaryRoot, "wiki");
  const previewPath = resolve(temporaryRoot, "previews");
  const reportPath = resolve(temporaryRoot, "report.json");
  const fixture = fileURLToPath(new URL("./fixtures/wiki", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  await cp(fixture, wikiPath, { recursive: true });
  await writeFile(
    resolve(wikiPath, "tiddlers", "Markdown.tid"),
    [
      "title: Markdown media",
      "tags: Media",
      "type: text/markdown",
      "",
      "![Local](<local image.png>)",
      "![Embedded](data:image/png;base64,abc)",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    resolve(wikiPath, "tiddlers", "Oversized.tid"),
    [
      "title: Oversized",
      "tags: Media",
      "type: text/plain",
      "",
      "x".repeat(32_769),
      "",
    ].join("\n"),
    "utf8",
  );
  t.after(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  const result = await run(
    "nub",
    [
      cliPath,
      "plan",
      "--tag",
      "Media",
      "--preview-dir",
      previewPath,
      "--report",
      reportPath,
    ],
    { cwd: wikiPath, env: process.env },
  );

  assert.equal(result.code, 1);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    entries: Array<{
      error?: string;
      id?: string;
      status: string;
      title: string;
      warnings?: string[];
    }>;
  };
  const markdownEntry = report.entries.find(
    (entry) => entry.title === "Markdown media",
  );
  const oversizedEntry = report.entries.find(
    (entry) => entry.title === "Oversized",
  );
  assert.ok(markdownEntry?.id);
  assert.equal(markdownEntry.status, "ready");
  assert.deepEqual(markdownEntry.warnings, [
    "local:local image.png",
    "embedded:image/png",
  ]);
  const preview = await readFile(
    resolve(previewPath, "wiki", `${markdownEntry.id}.md`),
    "utf8",
  );
  assert.match(preview, /\[Embedded image: Embedded\]/u);
  assert.doesNotMatch(preview, /base64/u);
  assert.equal(oversizedEntry?.status, "failed:validation");
  assert.match(oversizedEntry?.error ?? "", /limit of 32768 characters/u);
});
