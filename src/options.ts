export interface ImportOptions {
  allowRemote: boolean;
  apply: boolean;
  includeSensitive: boolean;
  jobs: number;
  limit: number;
  previewDir: string;
  reportPath: string;
  spaceId: string;
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
    allowRemote: false,
    apply: false,
    includeSensitive: false,
    jobs: 4,
    limit: Number.POSITIVE_INFINITY,
    previewDir: "",
    reportPath: "",
    spaceId: "default",
  };

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
      case "--allow-remote":
        options.allowRemote = true;
        break;
      case "--apply":
        options.apply = true;
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
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  return options;
}
