import { createHash } from "node:crypto";

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
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
  renderError?: string;
  tags?: string | string[];
  text: string;
  title: string;
  type?: string;
}

export type TiddlerClassification =
  | "draft"
  | "empty"
  | "ready"
  | "sensitive"
  | "system"
  | "unsupported_type";

interface ClassificationOptions {
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
  const { includeSensitive = false } = options;
  const title = tiddler.title ?? "";
  const type = tiddler.type ?? "text/vnd.tiddlywiki";

  if (!title || title.startsWith("$:/")) {
    return "system";
  }
  if (tiddler.draftOf || tiddler.draftTitle) {
    return "draft";
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

export function stableMemoryId(sourceWiki: string, title: string): string {
  const namespace = Buffer.from(DNS_NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(`tiddlywiki-nmem-importer\0${sourceWiki}\0${title}`, "utf8")
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
  const pattern = /<img\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)')[^>]*>/giu;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const source = match[1] ?? match[2] ?? "";
    let reference = "";
    if (source.startsWith("data:")) {
      reference = `embedded:${source.slice(5).split(/[;,]/u, 1)[0]}`;
    } else if (
      source &&
      !source.startsWith("https://") &&
      !source.startsWith("http://")
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

export function buildMemoryMarkdown(
  tiddler: TiddlerRecord,
  sourceWiki: string,
  body: string,
): string {
  const tags = parseTagString(tiddler.tags);
  const metadata = [
    "---",
    `tiddlywiki_source: ${JSON.stringify(sourceWiki)}`,
    `tiddlywiki_title: ${JSON.stringify(tiddler.title)}`,
    `tiddlywiki_tags: ${JSON.stringify(tags)}`,
    `tiddlywiki_created: ${JSON.stringify(toIsoTimestamp(tiddler.created))}`,
    `tiddlywiki_modified: ${JSON.stringify(toIsoTimestamp(tiddler.modified))}`,
    "---",
  ].join("\n");

  return `${metadata}\n\n${body.trim()}\n`;
}
