# TiddlyWiki to Nowledge Mem Importer

Batch-convert tiddlers from a Node.js TiddlyWiki into Markdown and import them as Memories in [Nowledge Mem](https://mem.nowledge.co/).

The importer boots the real Wiki through the TiddlyWiki npm package. WikiText is rendered to HTML by TiddlyWiki and then converted to GitHub Flavored Markdown. The default mode is a dry-run: it does not modify the source Wiki or write to Nowledge Mem.

## Prerequisites

- A Node.js TiddlyWiki whose root directory contains `tiddlywiki.info`
- [mise](https://mise.jdx.dev/)
- The latest installed `nmem` CLI and a healthy Nowledge Mem service running the same version

Check Nowledge Mem before importing:

```bash
nmem --version
nmem status
```

The importer only permits a local service (`localhost`, `127.0.0.1`, or `::1`) by default.

## Installation

```bash
git clone https://github.com/ThaddeusJiang/tiddlywiki-nmem-importer.git
cd tiddlywiki-nmem-importer
mise install
npm ci
```

Keep the absolute path to the cloned repository. The examples below use `/path/to/tiddlywiki-nmem-importer`.

## Usage

### 1. Enter the TiddlyWiki root directory

Run the importer from the root of the target TiddlyWiki. The current working directory is the only data source; the importer does not scan parent directories, sibling directories, or a predefined Wiki list.

```bash
cd /path/to/my-wiki
test -r tiddlywiki.info
```

### 2. Start with a dry-run

```bash
MISE_CONFIG_FILE=/path/to/tiddlywiki-nmem-importer/mise.toml \
mise exec -- nub \
/path/to/tiddlywiki-nmem-importer/src/cli.ts
```

A dry-run loads, filters, and converts tiddlers and writes a JSON report, but it never calls `nmem memories add`. By default, reports are written to the importer's `reports/` directory.

Limit the run to the first 20 importable tiddlers and write Markdown previews:

```bash
MISE_CONFIG_FILE=/path/to/tiddlywiki-nmem-importer/mise.toml \
mise exec -- nub \
/path/to/tiddlywiki-nmem-importer/src/cli.ts \
  --limit 20 \
  --preview-dir /tmp/tiddlywiki-nmem-preview \
  --report /tmp/tiddlywiki-nmem-report.json
```

Review `failed`, `warnings`, and `skipped` in the report before applying the import.

### 3. Import Memories

Add `--apply` after confirming the dry-run results:

```bash
MISE_CONFIG_FILE=/path/to/tiddlywiki-nmem-importer/mise.toml \
mise exec -- nub \
/path/to/tiddlywiki-nmem-importer/src/cli.ts \
  --apply
```

Choose a Nowledge Mem space and change the write concurrency when needed:

```bash
MISE_CONFIG_FILE=/path/to/tiddlywiki-nmem-importer/mise.toml \
mise exec -- nub \
/path/to/tiddlywiki-nmem-importer/src/cli.ts \
  --apply \
  --space-id personal \
  --jobs 2
```

Each Memory receives a stable ID derived from the Wiki directory name and tiddler title. Repeated runs upsert the same Memory instead of creating duplicate entries for the same title.

## Command-line options

| Option | Description |
| --- | --- |
| `--apply` | Write to Nowledge Mem; omit it for a dry-run |
| `--limit <count>` | Process at most this many importable tiddlers |
| `--jobs <count>` | Set concurrent writes; default: `4` |
| `--space-id <id>` | Select a Nowledge Mem space; default: `default` |
| `--include-sensitive` | Include tiddlers whose titles appear sensitive |
| `--allow-remote` | Permit writes to a non-local Nowledge Mem service |
| `--preview-dir <path>` | Write converted Markdown previews |
| `--report <path>` | Choose the JSON report path |
| `-h`, `--help` | Show command help |

The importer does not support `--wiki`. To import another Wiki, first change to that Wiki's root directory.

## Import rules

The importer skips these tiddlers by default:

- System tiddlers whose titles start with `$:/`
- Drafts
- Empty content
- Unsupported binary types
- Titles containing terms associated with tokens, API keys, secrets, passwords, or credentials

Sensitive-content detection checks titles only; it does not inspect tiddler bodies. Review the destination's access scope before using `--include-sensitive`.

Content conversion follows these rules:

- `text/vnd.tiddlywiki`: rendered by the active TiddlyWiki runtime and converted to GFM Markdown
- `text/markdown` and `text/plain`: source text is used directly
- Tags, creation time, modification time, source Wiki, and original title: stored in Markdown front matter
- Base64-embedded images: replaced with an omission marker instead of storing the binary data
- Local image references: preserved and reported as warnings

Imported Memories receive `tiddlywiki` and `tiddlywiki-<wiki-name>` labels and use `tiddlywiki` as their source.

## Safety

- Dry-run by default
- Never modifies or deletes source tiddlers
- Rejects remote Nowledge Mem services by default
- Confirms that the `nmem` CLI and service versions match without pinning a specific version
- Retries failed writes up to three times and records failures in the report
- Skips titles that appear sensitive by default

## Troubleshooting

### The current directory is not a TiddlyWiki root

If the importer reports:

```text
Current directory is not a TiddlyWiki root
```

Change to the directory containing `tiddlywiki.info` and run the command again.

### The nmem CLI and service versions do not match

Update and restart Nowledge Mem so these commands report the same version:

```bash
nmem --version
nmem status --json
```

### Preview conversion without importing

Omit `--apply` and use `--preview-dir` to write Markdown previews.

## Development

```bash
cd /path/to/tiddlywiki-nmem-importer
mise install
npm ci
mise exec -- nub run typecheck
mise exec -- nub run test
```

See [AGENTS.md](AGENTS.md) for development constraints and contribution guidance.
