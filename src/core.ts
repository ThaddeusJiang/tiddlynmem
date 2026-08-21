import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const NOWLEDGE_MEM_TAG = "$:/NowledgeMem";
export const NMEM_URI_FIELD = "nmem-uri";
export const NMEM_DIGEST_FIELD = "nmem-digest";
const MEMORY_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const IMPORTABLE_TYPES = new Set([
  "",
  "text/markdown",
  "text/plain",
  "text/vnd.tiddlywiki",
]);
const SENSITIVE_TITLE_PATTERN =
  /(?:token|api[ _-]?key|secret|password|credential|密码|密钥|口令)/iu;

export interface TiddlerRecord {
  created?: Date | string;
  draftOf?: string;
  draftTitle?: string;
  html?: string;
  modified?: Date | string;
  nmemDigest?: string;
  nmemUri?: string;
  renderError?: string;
  sourceFileDigest?: string;
  tags?: string | string[];
  text: string;
  title: string;
  type?: string;
}

export interface MarkdownMediaResult {
  markdown: string;
  warnings: string[];
}

export type TiddlerClassification =
  | "draft"
  | "empty"
  | "imported"
  | "ready"
  | "sensitive"
  | "system"
  | "unsupported_type";

interface ClassificationOptions {
  includeImported?: boolean;
  includeSensitive?: boolean;
}

export function parseTagString(value: string | string[] = ""): string[] {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  const tags: string[] = [];
  const pattern = /\[\[([^\]]+)\]\]|([^\s]+)/gu;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    tags.push(match[1] ?? match[2]);
  }

  return tags;
}

export function isSensitiveTitle(title: string): boolean {
  return SENSITIVE_TITLE_PATTERN.test(title ?? "");
}

export function shouldImportTiddler(
  tiddler: TiddlerRecord,
  options: ClassificationOptions = {},
): boolean {
  return classifyTiddler(tiddler, options) === "ready";
}

export function classifyTiddler(
  tiddler: TiddlerRecord,
  options: ClassificationOptions = {},
): TiddlerClassification {
  const { includeImported = false, includeSensitive = false } = options;
  const title = tiddler.title ?? "";
  const type = tiddler.type ?? "text/vnd.tiddlywiki";

  if (!title || title.startsWith("$:/")) {
    return "system";
  }
  if (tiddler.draftOf || tiddler.draftTitle) {
    return "draft";
  }
  if (
    !includeImported &&
    parseTagString(tiddler.tags).includes(NOWLEDGE_MEM_TAG)
  ) {
    return "imported";
  }
  if (!(tiddler.text ?? "").trim()) {
    return "empty";
  }
  if (!IMPORTABLE_TYPES.has(type)) {
    return "unsupported_type";
  }
  if (!includeSensitive && isSensitiveTitle(title)) {
    return "sensitive";
  }
  return "ready";
}

export function isMemoryDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function memoryIdFromUri(uri: string): string | undefined {
  const match = uri.match(
    new RegExp(`^nowledgemem://memory/(${MEMORY_ID_PATTERN})$`, "u"),
  );
  return match?.[1];
}

export function memoryUri(memoryId: string): string {
  return `nowledgemem://memory/${memoryId}`;
}

export function stableMemoryId(wikiId: string, title: string): string {
  const namespace = Buffer.from(DNS_NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(`tiddlywiki-nmem-importer\0${wikiId}\0${title}`, "utf8")
    .digest()
    .subarray(0, 16);

  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;

  const hex = digest.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function resolveWikiId(wikiPath: string, override = ""): string {
  const explicit = override.trim();
  if (explicit) {
    return explicit;
  }
  const resolvedPath = resolve(wikiPath).normalize("NFC");
  const name = basename(resolvedPath).normalize("NFKC") || "wiki";
  const fingerprint = createHash("sha256")
    .update(resolvedPath, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${name}-${fingerprint}`;
}

export function toIsoTimestamp(value?: Date | string | null): string {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }

  const match = String(value).match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/u,
  );
  if (!match) {
    return String(value);
  }

  const [, year, month, day, hour, minute, second, millisecond] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millisecond),
    ),
  ).toISOString();
}

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    fence: "```",
    headingStyle: "atx",
    strongDelimiter: "**",
  });
  service.use(gfm);
  service.remove(["button", "form", "input", "script", "select", "style", "textarea"]);
  service.addRule("embeddedImage", {
    filter(node) {
      return (
        node.nodeName === "IMG" &&
        (node.getAttribute("src") ?? "").startsWith("data:")
      );
    },
    replacement(_content, node) {
      const alt = node.getAttribute("alt")?.trim();
      return alt ? `[Embedded image: ${alt}]` : "[Embedded image omitted]";
    },
  });
  return service;
}

export function htmlToMarkdown(html: string): string {
  return createTurndownService()
    .turndown(html)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function findMediaReferences(html: string): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /<img\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/giu;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const source = match[1] ?? match[2] ?? match[3] ?? "";
    let reference = "";
    if (/^data:/iu.test(source)) {
      reference = `embedded:${source.slice(5).split(/[;,]/u, 1)[0]}`;
    } else if (
      source &&
      !/^https?:\/\//iu.test(source) &&
      !source.startsWith("//")
    ) {
      reference = `local:${source}`;
    }
    if (reference && !seen.has(reference)) {
      seen.add(reference);
      references.push(reference);
    }
  }

  return references;
}

export function sanitizeMarkdownMedia(markdown: string): MarkdownMediaResult {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const imagePattern =
    /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\)\r\n]*\)))?\s*\)/giu;
  const referenceImagePattern = /!\[([^\]\r\n]*)\]\[([^\]\r\n]*)\]/gu;
  const shortcutReferenceImagePattern = /!\[([^\]\r\n]+)\](?![\[(])/gu;
  const referenceDefinitionPattern =
    /^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|([^ \t\r\n]+))(?:[ \t]+.*)?$/gmu;
  const rawImagePattern =
    /<img\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/giu;
  const definitions = new Map<string, string>();
  const referencedLabels = new Set<string>();
  const normalizeReference = (value: string): string =>
    value.trim().replace(/\s+/gu, " ").toLowerCase();
  for (const match of markdown.matchAll(referenceDefinitionPattern)) {
    definitions.set(
      normalizeReference(match[1] ?? ""),
      (match[2] ?? match[3] ?? "").trim(),
    );
  }
  const addWarning = (warning: string): void => {
    if (!seen.has(warning)) {
      seen.add(warning);
      warnings.push(warning);
    }
  };
  const warningForSource = (source: string): string => {
    if (/^data:/iu.test(source)) {
      const mediaType = source.slice(5).split(/[;,]/u, 1)[0] || "unknown";
      return `embedded:${mediaType}`;
    }
    if (source && !/^https?:\/\//iu.test(source) && !source.startsWith("//")) {
      return `local:${source}`;
    }
    return "";
  };
  const embeddedImageMarker = (alt: string): string => {
    const label = alt.trim();
    return label ? `[Embedded image: ${label}]` : "[Embedded image omitted]";
  };

  let sanitized = markdown.replace(
    imagePattern,
    (match, alt: string, angledSource?: string, bareSource?: string) => {
      const source = (angledSource ?? bareSource ?? "").trim();
      const warning = warningForSource(source);
      if (warning) {
        addWarning(warning);
      }
      if (/^data:/iu.test(source)) {
        return embeddedImageMarker(alt);
      }
      return match;
    },
  );

  sanitized = sanitized.replace(
    referenceImagePattern,
    (match, alt: string, reference: string) => {
      const label = normalizeReference(reference || alt);
      const source = definitions.get(label);
      if (!source) {
        return match;
      }
      referencedLabels.add(label);
      const warning = warningForSource(source);
      if (warning) {
        addWarning(warning);
      }
      return /^data:/iu.test(source) ? embeddedImageMarker(alt) : match;
    },
  );

  sanitized = sanitized.replace(
    shortcutReferenceImagePattern,
    (match, alt: string) => {
      const label = normalizeReference(alt);
      const source = definitions.get(label);
      if (!source) {
        return match;
      }
      referencedLabels.add(label);
      const warning = warningForSource(source);
      if (warning) {
        addWarning(warning);
      }
      return /^data:/iu.test(source) ? embeddedImageMarker(alt) : match;
    },
  );

  sanitized = sanitized.replace(
    referenceDefinitionPattern,
    (match, label: string, angledSource?: string, bareSource?: string) => {
      const source = (angledSource ?? bareSource ?? "").trim();
      return referencedLabels.has(normalizeReference(label)) && /^data:/iu.test(source)
        ? `[${label}]: # "Embedded image omitted"`
        : match;
    },
  );

  sanitized = sanitized.replace(
    rawImagePattern,
    (
      match,
      doubleQuotedSource?: string,
      singleQuotedSource?: string,
      unquotedSource?: string,
    ) => {
      const source = (
        doubleQuotedSource ??
        singleQuotedSource ??
        unquotedSource ??
        ""
      ).trim();
      const warning = warningForSource(source);
      if (warning) {
        addWarning(warning);
      }
      if (!/^data:/iu.test(source)) {
        return match;
      }
      const altMatch = match.match(
        /\balt=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu,
      );
      return embeddedImageMarker(
        altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "",
      );
    },
  );

  return { markdown: sanitized, warnings };
}

export function buildMemoryContent(body: string): string {
  return `${body.trim()}\n`;
}
