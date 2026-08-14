# AGENTS.md

This file is the development and contribution contract for AI coding agents working in this repository.

## Project purpose

`tiddlywiki-nmem-importer` imports tiddlers from one Node.js TiddlyWiki into Nowledge Mem. It boots the real Wiki with the npm `tiddlywiki` package, renders WikiText to HTML, converts that HTML to GitHub Flavored Markdown, and upserts each result as a Memory through the installed `nmem` CLI.

`README.md` is the user-facing source of truth for installation and usage. Keep it synchronized whenever CLI behavior changes.

## Non-negotiable behavior

- The current working directory is the only Wiki input.
- The command must be run from a directory containing a readable `tiddlywiki.info`.
- Do not restore `--wiki`, hardcoded Wiki names, parent-directory scans, or sibling-directory scans.
- Default execution is a dry-run. Only `--apply` may write to Nowledge Mem.
- Never modify, move, or delete source tiddlers.
- Use the installed current `nmem`; never hardcode a required nmem version.
- Require the `nmem` CLI and service to report matching versions before writing.
- Reject remote Nowledge Mem services by default; require `--allow-remote` for an explicit override.
- Preserve deterministic Memory IDs based on source Wiki name and tiddler title so reruns remain idempotent.
- Preserve the default sensitive-title filter unless a deliberate behavior change includes tests and README updates.

## Language and runtime

- TypeScript everywhere.
- Do not add `.js` or `.mjs` source files.
- Run TypeScript directly with [Nub](https://github.com/nubjs/nub); do not use Bun.
- Keep `strict` TypeScript enabled.
- Use ESM imports with explicit `.ts` extensions, matching the existing codebase.
- Prefer small functions and declarative data transformations over unnecessary classes.
- Do not add a dependency when the Node.js standard library or an existing dependency is sufficient.

## Repository map

- `src/cli.ts`: CLI orchestration, current-directory validation, reporting, previews, and concurrent imports.
- `src/core.ts`: tiddler classification, metadata, stable IDs, HTML-to-Markdown conversion, and media warnings.
- `src/tiddlywiki-worker.ts`: boots TiddlyWiki and sends records over IPC.
- `src/tiddlywiki.ts`: owns worker lifecycle, IPC validation, and diagnostics.
- `src/nmem.ts`: validates the active nmem service and invokes `nmem memories add`.
- `src/options.ts`: parses supported command-line options.
- `test/`: Node test runner coverage and a minimal TiddlyWiki fixture.
- `reports/`, `previews/`: generated output; both are ignored and must not be committed.

## Architecture constraints

Keep TiddlyWiki execution in the child worker. TiddlyWiki boot diagnostics must not be mixed with structured tiddler records; records travel through IPC and stderr is collected separately.

Conversion behavior is type-dependent:

- `text/vnd.tiddlywiki` and the empty/default type are rendered by TiddlyWiki before Turndown conversion.
- `text/markdown` and `text/plain` use their source text directly.
- Unsupported binary types, system tiddlers, drafts, empty tiddlers, and sensitive-title tiddlers are classified and reported instead of imported.

Memory content includes TiddlyWiki source metadata in front matter. Keep source Wiki, title, tags, created time, and modified time available unless a documented migration replaces them.

The nmem process must receive Memory content through stdin. Do not place note content in command-line arguments or logs.

## Setup

```bash
mise install
npm ci
```

The repository pins its Node, Nub, npm package, and TypeScript toolchain through `mise.toml`, `package.json`, and `package-lock.json`. The nmem version is intentionally not pinned in source code.

## Required validation

Run both commands after every source or test change:

```bash
mise exec -- nub run typecheck
mise exec -- nub run test
```

For CLI behavior involving Wiki discovery or rendering, also run a dry-run from `test/fixtures/wiki` or another disposable Wiki root. Never use `--apply` in tests or validation unless the user explicitly authorizes writes to Nowledge Mem.

Tests must cover behavior, not implementation details. Add or update tests when changing:

- CLI options and defaults
- tiddler classification
- WikiText/HTML/Markdown conversion
- deterministic IDs or metadata
- nmem compatibility and command arguments
- worker IPC and multiline content

## Contribution workflow

1. Read `README.md`, this file, and the source files relevant to the requested behavior.
2. Inspect the repository for all references before changing a public option, report field, ID algorithm, label, or conversion rule.
3. Keep the patch scoped to the request and preserve unrelated user changes.
4. Update tests and user documentation in the same change when behavior changes.
5. Run typecheck and the full test suite.
6. Review the final diff for generated files, note content, credentials, and accidental dependency changes.
7. Do not commit, push, publish, or create a pull request unless the user explicitly asks.

## Documentation contract

Every project must contain both files:

- `README.md`: written for human users, centered on setup and practical usage.
- `AGENTS.md`: written for AI coding agents, centered on architecture, development constraints, validation, and contribution.

When project behavior changes, update the relevant sections rather than allowing either document to become historical or aspirational.
