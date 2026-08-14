import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  addMemory,
  buildMemoryRequest,
  checkNmemService,
  resolveNmemApiUrl,
  sourceWikiLabel,
  validateMemoryInput,
} from "../src/nmem.ts";

const memory = {
  content: "Body\n",
  created: "2025-08-10T12:57:15.658Z",
  id: "8ea941d0-3d95-50e6-9c9d-dd10341f4f72",
  modified: "2025-08-12T07:15:35.863Z",
  sourceWiki: "myblog",
  tags: ["Tech", "long tag"],
  title: "Example",
  wikiId: "myblog-a1b2c3d4e5f6",
};

function successfulMemoryResponse(id = memory.id): Response {
  return new Response(
    JSON.stringify({ action: "created", memory: { id } }),
    { status: 200 },
  );
}

test("buildMemoryRequest maps TiddlyWiki fields to native Memory properties", () => {
  const request = buildMemoryRequest(
    memory,
    { spaceId: "default" },
  );

  assert.deepEqual(request, {
    content: "Body\n",
    id: "8ea941d0-3d95-50e6-9c9d-dd10341f4f72",
    labels: ["tiddlywiki", "tiddlywiki-myblog", "Tech", "long tag"],
    metadata: {
      tiddlywiki_created: "2025-08-10T12:57:15.658Z",
      tiddlywiki_modified: "2025-08-12T07:15:35.863Z",
      tiddlywiki_source: "myblog",
      tiddlywiki_tags: ["Tech", "long tag"],
      tiddlywiki_title: "Example",
      tiddlywiki_wiki_id: "myblog-a1b2c3d4e5f6",
    },
    source: "tiddlywiki",
    source_app: "tiddlynmem",
    space_id: "default",
    title: "Example",
  });
});

test("sourceWikiLabel preserves non-Latin names and avoids empty slugs", () => {
  assert.equal(sourceWikiLabel("public-DevNote"), "tiddlywiki-public-devnote");
  assert.equal(sourceWikiLabel("技术笔记"), "tiddlywiki-技术笔记");
  assert.match(sourceWikiLabel("---"), /^tiddlywiki-[0-9a-f]{8}$/u);
});

test("validateMemoryInput enforces the current native API limits", () => {
  assert.deepEqual(validateMemoryInput(memory), []);
  assert.deepEqual(
    validateMemoryInput({ ...memory, title: "x".repeat(201) }),
    ["Memory title exceeds the Nowledge Mem limit of 200 characters (received 201)."],
  );
  assert.deepEqual(
    validateMemoryInput({ ...memory, content: "😀".repeat(32_769) }),
    [
      "Memory content exceeds the Nowledge Mem limit of 32768 characters (received 32769).",
    ],
  );
});

test("addMemory posts the native request to the active service", async () => {
  let capturedInput: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return successfulMemoryResponse();
  }) as typeof fetch;

  const result = await addMemory(
    {
      ...memory,
    },
    {
      apiKey: "test-key",
      apiUrl: "http://127.0.0.1:14242/api/",
      attempts: 1,
      fetchImpl,
      spaceId: "research",
    },
  );

  assert.deepEqual(result, {
    action: "created",
    memory: { id: memory.id },
  });
  assert.equal(String(capturedInput), "http://127.0.0.1:14242/api/memories");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.deepEqual(capturedInit?.headers, {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  });
  const body = JSON.parse(String(capturedInit?.body)) as {
    content: string;
    labels: string[];
    metadata: Record<string, unknown>;
    space_id: string;
  };
  assert.equal(body.content, "Body\n");
  assert.deepEqual(body.labels, [
    "tiddlywiki",
    "tiddlywiki-myblog",
    "Tech",
    "long tag",
  ]);
  assert.deepEqual(body.metadata, {
    tiddlywiki_created: "2025-08-10T12:57:15.658Z",
    tiddlywiki_modified: "2025-08-12T07:15:35.863Z",
    tiddlywiki_source: "myblog",
    tiddlywiki_tags: ["Tech", "long tag"],
    tiddlywiki_title: "Example",
    tiddlywiki_wiki_id: "myblog-a1b2c3d4e5f6",
  });
  assert.equal(body.space_id, "research");
});

test("addMemory does not retry a permanent client error or expose its body", async () => {
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    return new Response('{"detail":"secret tiddler body"}', { status: 422 });
  }) as typeof fetch;

  await assert.rejects(
    addMemory(memory, {
      apiUrl: "http://127.0.0.1:14242",
      attempts: 3,
      fetchImpl,
      waitImpl: async () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 422/u);
      assert.doesNotMatch(error.message, /secret tiddler body/u);
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("addMemory does not expose an invalid success response body", async () => {
  const fetchImpl = (async () =>
    new Response("secret tiddler body", { status: 200 })) as typeof fetch;

  await assert.rejects(
    addMemory(memory, {
      apiUrl: "http://127.0.0.1:14242",
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid JSON response/u);
      assert.doesNotMatch(error.message, /secret tiddler body/u);
      return true;
    },
  );
});

test("addMemory rejects a success response without a confirmed Memory ID", async () => {
  for (const responseBody of [
    "",
    {},
    { error: "secret upstream error" },
    { memory: {} },
  ]) {
    await assert.rejects(
      addMemory(memory, {
        apiUrl: "http://127.0.0.1:14242",
        attempts: 1,
        fetchImpl: (async () =>
          new Response(
            typeof responseBody === "string"
              ? responseBody
              : JSON.stringify(responseBody),
            {
              status: 200,
            },
          )) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /valid Memory ID/u);
        assert.doesNotMatch(error.message, /secret upstream error/u);
        return true;
      },
    );
  }
});

test("addMemory rejects a response for a different Memory ID", async () => {
  await assert.rejects(
    addMemory(memory, {
      apiUrl: "http://127.0.0.1:14242",
      attempts: 1,
      fetchImpl: (async () =>
        successfulMemoryResponse("different-memory-id")) as typeof fetch,
    }),
    /does not match the requested ID/u,
  );
});

test("addMemory rejects redirects without forwarding the tiddler", async (t) => {
  let redirectedRequests = 0;
  let redirectedBody = "";
  const target = createServer(async (request, response) => {
    redirectedRequests += 1;
    for await (const chunk of request) {
      redirectedBody += chunk;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ action: "created", memory: { id: memory.id } }),
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolveListen);
  });
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");

  const redirector = createServer((_request, response) => {
    response.writeHead(307, {
      Location: `http://127.0.0.1:${targetAddress.port}/capture`,
    });
    response.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    redirector.once("error", reject);
    redirector.listen(0, "127.0.0.1", resolveListen);
  });
  const redirectorAddress = redirector.address();
  assert.ok(redirectorAddress && typeof redirectorAddress !== "string");

  t.after(async () => {
    await Promise.all([
      new Promise<void>((resolveClose, reject) => {
        redirector.close((error) =>
          error ? reject(error) : resolveClose(),
        );
      }),
      new Promise<void>((resolveClose, reject) => {
        target.close((error) => (error ? reject(error) : resolveClose()));
      }),
    ]);
  });

  await assert.rejects(
    addMemory(memory, {
      apiUrl: `http://127.0.0.1:${redirectorAddress.port}`,
      attempts: 1,
    }),
  );
  assert.equal(redirectedRequests, 0);
  assert.equal(redirectedBody, "");
});

test("addMemory retries a transient server error", async () => {
  let requests = 0;
  const delays: number[] = [];
  const fetchImpl = (async () => {
    requests += 1;
    return requests === 1
      ? new Response("temporary", { status: 503 })
      : successfulMemoryResponse();
  }) as typeof fetch;

  const result = await addMemory(memory, {
    apiUrl: "http://127.0.0.1:14242",
    attempts: 3,
    fetchImpl,
    waitImpl: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.deepEqual(result, {
    action: "created",
    memory: { id: memory.id },
  });
  assert.equal(requests, 2);
  assert.deepEqual(delays, [250]);
});

test("addMemory caps server-requested retry delays", async () => {
  let requests = 0;
  const delays: number[] = [];
  const fetchImpl = (async () => {
    requests += 1;
    return requests === 1
      ? new Response("slow down", {
          headers: { "Retry-After": "120" },
          status: 429,
        })
      : successfulMemoryResponse();
  }) as typeof fetch;

  await addMemory(memory, {
    apiUrl: "http://127.0.0.1:14242",
    fetchImpl,
    waitImpl: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.deepEqual(delays, [30_000]);
});

test("addMemory bounds each request with a timeout", async () => {
  const fetchImpl = ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;

  await assert.rejects(
    addMemory(memory, {
      apiUrl: "http://127.0.0.1:14242",
      attempts: 1,
      fetchImpl,
      timeoutMs: 5,
    }),
    /timed out after 5ms/u,
  );
});

test("resolveNmemApiUrl uses CLI, environment, then localhost precedence", () => {
  assert.equal(resolveNmemApiUrl(), "http://127.0.0.1:14242");
  assert.equal(
    resolveNmemApiUrl("", "http://localhost:15555"),
    "http://localhost:15555",
  );
  assert.equal(
    resolveNmemApiUrl(
      "http://127.0.0.1:16666/",
      "http://localhost:15555",
    ),
    "http://127.0.0.1:16666",
  );
});

test("resolveNmemApiUrl rejects unsafe or unsupported URLs", () => {
  assert.throws(() => resolveNmemApiUrl("not a URL"), /valid URL/u);
  assert.throws(
    () => resolveNmemApiUrl("file:///tmp/nmem"),
    /HTTP or HTTPS/u,
  );
  assert.throws(
    () => resolveNmemApiUrl("https://user:password@example.com"),
    /credentials/u,
  );
});

test("resolveNmemApiUrl accepts explicit remote HTTP and HTTPS endpoints", () => {
  assert.equal(
    resolveNmemApiUrl("http://192.168.1.20:14242"),
    "http://192.168.1.20:14242",
  );
  assert.equal(
    resolveNmemApiUrl("https://mem.example.com/"),
    "https://mem.example.com",
  );
});

test("checkNmemService checks the REST health endpoint directly", async () => {
  let capturedInput: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (input, init) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(
      JSON.stringify({ services_ready: true, status: "ok", version: "0.10.61" }),
      { status: 200 },
    );
  }) as typeof fetch;

  const health = await checkNmemService({
    apiKey: "test-key",
    apiUrl: "http://192.168.1.20:14242",
    fetchImpl,
  });

  assert.equal(String(capturedInput), "http://192.168.1.20:14242/health");
  assert.equal(capturedInit?.method, "GET");
  assert.equal(capturedInit?.redirect, "error");
  assert.deepEqual(capturedInit?.headers, {
    Authorization: "Bearer test-key",
    Accept: "application/json",
  });
  assert.equal(health.status, "ok");
  assert.equal(health.version, "0.10.61");
});

test("checkNmemService rejects redirects without contacting the target", async (t) => {
  let targetRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ services_ready: true, status: "ok", version: "0.10.62" }),
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolveListen);
  });
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");

  const redirector = createServer((_request, response) => {
    response.writeHead(307, {
      Location: `http://127.0.0.1:${targetAddress.port}/health`,
    });
    response.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    redirector.once("error", reject);
    redirector.listen(0, "127.0.0.1", resolveListen);
  });
  const redirectorAddress = redirector.address();
  assert.ok(redirectorAddress && typeof redirectorAddress !== "string");

  t.after(async () => {
    await Promise.all([
      new Promise<void>((resolveClose, reject) => {
        redirector.close((error) =>
          error ? reject(error) : resolveClose(),
        );
      }),
      new Promise<void>((resolveClose, reject) => {
        target.close((error) => (error ? reject(error) : resolveClose()));
      }),
    ]);
  });

  await assert.rejects(
    checkNmemService({
      apiUrl: `http://127.0.0.1:${redirectorAddress.port}`,
    }),
  );
  assert.equal(targetRequests, 0);
});

test("checkNmemService rejects an unhealthy REST service", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ services_ready: false, status: "ok", version: "0.10.61" }),
      { status: 200 },
    )) as typeof fetch;

  await assert.rejects(
    checkNmemService({
      apiUrl: "http://127.0.0.1:14242",
      fetchImpl,
    }),
    /not ready/u,
  );
});

test("checkNmemService rejects an invalid health response", async () => {
  const fetchImpl = (async () =>
    new Response("not json", { status: 200 })) as typeof fetch;

  await assert.rejects(
    checkNmemService({
      apiUrl: "http://127.0.0.1:14242",
      fetchImpl,
    }),
    /invalid health response/u,
  );
});
