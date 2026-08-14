import { createRequire } from "node:module";
import { tmpdir } from "node:os";

interface TiddlerFileInfo {
  filepath: string;
  hasMetaFile: boolean;
  type: string;
}

interface TiddlyWikiTiddler {
  fields: {
    tags?: string[];
    title: string;
  };
}

interface TiddlyWikiRuntime {
  Tiddler: new (
    ...fieldMaps: Array<TiddlyWikiTiddler | Record<string, unknown>>
  ) => TiddlyWikiTiddler;
  boot: {
    argv: string[];
    boot(callback: () => void): void;
    files: Record<string, TiddlerFileInfo | undefined>;
  };
  utils: {
    saveTiddlerToFile(
      tiddler: TiddlyWikiTiddler,
      fileInfo: TiddlerFileInfo,
      callback: (error?: Error | string | null) => void,
    ): void;
  };
  wiki: {
    getModificationFields(): Record<string, unknown>;
    getTiddler(title: string): TiddlyWikiTiddler | undefined;
  };
}

interface TagRequest {
  tag: string;
  titles: string[];
  type: "tag";
}

const require = createRequire(import.meta.url);
const { TiddlyWiki } = require("tiddlywiki/boot/boot.js") as {
  TiddlyWiki(): TiddlyWikiRuntime;
};
const wikiPath = process.argv[2];

if (!wikiPath) {
  throw new Error("A TiddlyWiki path is required.");
}

if (!process.send) {
  throw new Error("The TiddlyWiki tag worker requires a Node IPC channel.");
}

function isTagRequest(message: unknown): message is TagRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "tag" &&
    "tag" in message &&
    typeof message.tag === "string" &&
    "titles" in message &&
    Array.isArray(message.titles) &&
    message.titles.every((title) => typeof title === "string")
  );
}

function saveTiddler(
  tw: TiddlyWikiRuntime,
  tiddler: TiddlyWikiTiddler,
  fileInfo: TiddlerFileInfo,
): Promise<void> {
  return new Promise((resolve, reject) => {
    tw.utils.saveTiddlerToFile(tiddler, fileInfo, (error) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } else {
        resolve();
      }
    });
  });
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send!(message, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function tagTiddlers(
  tw: TiddlyWikiRuntime,
  request: TagRequest,
): Promise<void> {
  for (const title of request.titles) {
    try {
      const tiddler = tw.wiki.getTiddler(title);
      if (!tiddler) {
        throw new Error("The source tiddler no longer exists.");
      }

      const tags = Array.isArray(tiddler.fields.tags)
        ? tiddler.fields.tags
        : [];
      if (tags.includes(request.tag)) {
        await send({ status: "already-present", title, type: "result" });
        continue;
      }

      const fileInfo = tw.boot.files[title];
      if (!fileInfo) {
        throw new Error("The source tiddler is not backed by a writable file.");
      }
      if (
        !fileInfo.hasMetaFile &&
        fileInfo.type !== "application/x-tiddler"
      ) {
        throw new Error(
          `Refusing to rewrite unsupported source file type ${fileInfo.type}.`,
        );
      }

      const updated = new tw.Tiddler(
        tiddler,
        { tags: [...tags, request.tag] },
        tw.wiki.getModificationFields(),
      );
      await saveTiddler(tw, updated, fileInfo);
      await send({ status: "added", title, type: "result" });
    } catch (error) {
      await send({
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
        title,
        type: "result",
      });
    }
  }

  await send({ type: "done" });
  process.disconnect();
}

const tw = TiddlyWiki();
tw.boot.argv = [wikiPath, "--output", tmpdir()];
tw.boot.boot(() => {
  process.once("message", (message) => {
    if (!isTagRequest(message)) {
      process.stderr.write("The TiddlyWiki tag request is invalid.\n");
      process.exit(1);
      return;
    }

    void tagTiddlers(tw, message).catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
  });
  void send({ type: "ready" }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
});
