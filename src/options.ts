export type ImportCommand = "apply" | "plan";

export interface ImportOptions {
  apiUrl: string;
  command: ImportCommand;
  includeSensitive: boolean;
  jobs: number;
  limit: number;
  previewDir: string;
  reportPath: string;
  spaceId: string;
  tag: string;
  wikiId: string;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return parsed;
}

export function parseArgs(args: string[]): ImportOptions {
  const options: ImportOptions = {
    apiUrl: "",
    command: "plan",
    includeSensitive: false,
    jobs: 4,
    limit: Number.POSITIVE_INFINITY,
    previewDir: "",
    reportPath: "",
    spaceId: "default",
    tag: "",
    wikiId: "",
  };
  let commandSpecified = false;

  const takeValue = (index: number, option: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    switch (option) {
      case "--":
        break;
      case "apply":
      case "plan":
        if (commandSpecified) {
          throw new Error("Only one command may be specified.");
        }
        options.command = option;
        commandSpecified = true;
        break;
      case "--api-url":
        options.apiUrl = takeValue(index, option);
        index += 1;
        break;
      case "--include-sensitive":
        options.includeSensitive = true;
        break;
      case "--jobs": {
        const value = takeValue(index, option);
        options.jobs = positiveInteger(value, option);
        index += 1;
        break;
      }
      case "--limit": {
        const value = takeValue(index, option);
        options.limit = positiveInteger(value, option);
        index += 1;
        break;
      }
      case "--preview-dir":
        options.previewDir = takeValue(index, option);
        index += 1;
        break;
      case "--report":
        options.reportPath = takeValue(index, option);
        index += 1;
        break;
      case "--space-id":
        options.spaceId = takeValue(index, option);
        index += 1;
        break;
      case "--tag":
        if (options.tag) {
          throw new Error("--tag may only be specified once.");
        }
        options.tag = takeValue(index, option);
        index += 1;
        break;
      case "--wiki-id": {
        const value = takeValue(index, option).trim();
        if (!value) {
          throw new Error("--wiki-id requires a non-empty value.");
        }
        options.wikiId = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  return options;
}
