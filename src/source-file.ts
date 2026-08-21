import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface TiddlerFileInfo {
  filepath: string;
  hasMetaFile: boolean;
  type: string;
}

export async function sourceFileDigest(
  fileInfo: TiddlerFileInfo,
): Promise<string> {
  const paths = fileInfo.hasMetaFile
    ? [fileInfo.filepath, `${fileInfo.filepath}.meta`]
    : [fileInfo.filepath];
  const contents = await Promise.all(paths.map((path) => readFile(path)));
  const hash = createHash("sha256");

  for (const content of contents) {
    hash.update(`${content.byteLength}:`, "utf8");
    hash.update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}
