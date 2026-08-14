import { createHash } from "node:crypto";

export const DEFAULT_NMEM_API_URL = "http://127.0.0.1:14242";
export const MEMORY_CONTENT_MAX_LENGTH = 32_768;
export const MEMORY_TITLE_MAX_LENGTH = 200;
const MEMORY_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30_000;

export interface MemoryInput {
  content: string;
  created: string;
  id: string;
  modified: string;
  sourceWiki: string;
  tags: string[];
  title: string;
  wikiId: string;
}

export interface MemoryCreateRequest {
  content: string;
  id: string;
  labels: string[];
  metadata: {
    tiddlywiki_created: string;
    tiddlywiki_modified: string;
    tiddlywiki_source: string;
    tiddlywiki_tags: string[];
    tiddlywiki_title: string;
    tiddlywiki_wiki_id: string;
  };
  source: "tiddlywiki";
  source_app: "tiddlynmem";
  space_id: string;
  title: string;
}

export interface MemoryCreateResponse {
  action?: string;
  memory: {
    id: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NmemHealth {
  database_connected?: boolean;
  services_ready?: boolean;
  status: string;
  version?: string;
}

interface AddMemoryOptions {
  apiKey?: string;
  apiUrl: string;
  attempts?: number;
  fetchImpl?: typeof fetch;
  spaceId?: string;
  timeoutMs?: number;
  waitImpl?: (milliseconds: number) => Promise<void>;
}

interface CheckNmemServiceOptions {
  apiKey?: string;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function sourceWikiLabel(sourceWiki: string): string {
  const slug = sourceWiki
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (slug) {
    return `tiddlywiki-${slug}`;
  }
  const fallback = createHash("sha256")
    .update(sourceWiki, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `tiddlywiki-${fallback}`;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

export function validateMemoryInput(
  memory: Pick<MemoryInput, "content" | "title">,
): string[] {
  const errors: string[] = [];
  const titleLength = characterLength(memory.title);
  const contentLength = characterLength(memory.content);
  if (titleLength > MEMORY_TITLE_MAX_LENGTH) {
    errors.push(
      `Memory title exceeds the Nowledge Mem limit of ${MEMORY_TITLE_MAX_LENGTH} characters (received ${titleLength}).`,
    );
  }
  if (contentLength > MEMORY_CONTENT_MAX_LENGTH) {
    errors.push(
      `Memory content exceeds the Nowledge Mem limit of ${MEMORY_CONTENT_MAX_LENGTH} characters (received ${contentLength}).`,
    );
  }
  return errors;
}

export function buildMemoryRequest(
  memory: MemoryInput,
  options: Pick<AddMemoryOptions, "spaceId"> = {},
): MemoryCreateRequest {
  const { spaceId = "default" } = options;
  return {
    content: memory.content,
    id: memory.id,
    labels: [
      ...new Set([
        "tiddlywiki",
        sourceWikiLabel(memory.sourceWiki),
        ...memory.tags,
      ]),
    ],
    metadata: {
      tiddlywiki_created: memory.created,
      tiddlywiki_modified: memory.modified,
      tiddlywiki_source: memory.sourceWiki,
      tiddlywiki_tags: memory.tags,
      tiddlywiki_title: memory.title,
      tiddlywiki_wiki_id: memory.wikiId,
    },
    source: "tiddlywiki",
    source_app: "tiddlynmem",
    space_id: spaceId,
    title: memory.title,
  };
}

export function resolveNmemApiUrl(
  optionValue = "",
  environmentValue = process.env.NMEM_API_URL ?? "",
): string {
  const candidate =
    optionValue.trim() || environmentValue.trim() || DEFAULT_NMEM_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new Error(`Nowledge Mem API URL is not a valid URL: ${candidate}`, {
      cause: error,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Nowledge Mem API URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "Nowledge Mem API URL must not contain credentials; use NMEM_API_KEY instead.",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Nowledge Mem API URL must not contain a query or fragment.");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function apiEndpointUrl(apiUrl: string, endpoint: string): URL {
  const baseUrl = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  return new URL(endpoint, baseUrl);
}

export async function checkNmemService(
  options: CheckNmemServiceOptions,
): Promise<NmemHealth> {
  const {
    apiKey = process.env.NMEM_API_KEY?.trim(),
    apiUrl,
    fetchImpl = fetch,
    timeoutMs = MEMORY_REQUEST_TIMEOUT_MS,
  } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Nowledge Mem health-check timeout must be a positive number.",
    );
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(apiEndpointUrl(apiUrl, "health"), {
      headers,
      method: "GET",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        `Nowledge Mem health check timed out after ${timeoutMs}ms.`,
        { cause: error },
      );
    }
    throw new Error(`Unable to reach Nowledge Mem at ${apiUrl}.`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(
      `Nowledge Mem health check returned HTTP ${response.status}.`,
    );
  }
  const body = await response.text();
  let health: unknown;
  try {
    health = body ? JSON.parse(body) : null;
  } catch (error) {
    throw new Error("Nowledge Mem returned an invalid health response.", {
      cause: error,
    });
  }
  if (
    !health ||
    typeof health !== "object" ||
    !("status" in health) ||
    typeof health.status !== "string"
  ) {
    throw new Error("Nowledge Mem returned an invalid health response.");
  }
  const result = health as NmemHealth;
  if (result.status !== "ok") {
    throw new Error(`Nowledge Mem is unhealthy (status: ${result.status}).`);
  }
  if (result.services_ready === false || result.database_connected === false) {
    throw new Error("Nowledge Mem is not ready to accept imports.");
  }
  return result;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function memoriesUrl(apiUrl: string): URL {
  return apiEndpointUrl(apiUrl, "memories");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function parseMemoryResponse(
  response: Response,
  expectedMemoryId: string,
): Promise<MemoryCreateResponse> {
  if (!response.ok) {
    const error = new Error(
      `Nowledge Mem API returned HTTP ${response.status}.`,
    ) as Error & { retryAfterMs?: number; status: number };
    error.status = response.status;
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const milliseconds = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1_000)
        : Math.max(0, Date.parse(retryAfter) - Date.now());
      if (Number.isFinite(milliseconds)) {
        error.retryAfterMs = Math.min(milliseconds, MAX_RETRY_DELAY_MS);
      }
    }
    throw error;
  }
  const body = await response.text();
  if (!body) {
    throw new Error(
      "Nowledge Mem API response did not include a valid Memory ID.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Nowledge Mem API returned an invalid JSON response.");
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.memory) ||
    typeof parsed.memory.id !== "string" ||
    !parsed.memory.id
  ) {
    throw new Error(
      "Nowledge Mem API response did not include a valid Memory ID.",
    );
  }
  if (parsed.memory.id !== expectedMemoryId) {
    throw new Error(
      "Nowledge Mem API response Memory ID does not match the requested ID.",
    );
  }
  return parsed as MemoryCreateResponse;
}

function isHttpStatusError(
  error: unknown,
): error is Error & { retryAfterMs?: number; status: number } {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  );
}

function isRetryableError(error: unknown): boolean {
  if (isHttpStatusError(error)) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

export async function addMemory(
  memory: MemoryInput,
  options: AddMemoryOptions,
): Promise<MemoryCreateResponse> {
  const {
    apiKey = process.env.NMEM_API_KEY?.trim(),
    apiUrl,
    attempts = 3,
    fetchImpl = fetch,
    spaceId = "default",
    timeoutMs = MEMORY_REQUEST_TIMEOUT_MS,
    waitImpl = wait,
  } = options;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error("Memory import attempts must be a positive integer.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Memory request timeout must be a positive number.");
  }
  const validationErrors = validateMemoryInput(memory);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join(" "));
  }
  const request = buildMemoryRequest(memory, { spaceId });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  let lastError: unknown = new Error("The nmem import failed.");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(memoriesUrl(apiUrl), {
        body: JSON.stringify(request),
        headers,
        method: "POST",
        redirect: "error",
        signal,
      });
      return await parseMemoryResponse(response, memory.id);
    } catch (error) {
      lastError = signal.aborted
        ? Object.assign(
            new Error(`Nowledge Mem request timed out after ${timeoutMs}ms.`, {
              cause: error,
            }),
            { name: "TimeoutError" },
          )
        : error;
      if (attempt >= attempts || !isRetryableError(lastError)) {
        break;
      }
      const delay = isHttpStatusError(lastError)
        ? lastError.retryAfterMs ?? 250 * 2 ** (attempt - 1)
        : 250 * 2 ** (attempt - 1);
      await waitImpl(delay);
    }
  }

  throw lastError;
}
