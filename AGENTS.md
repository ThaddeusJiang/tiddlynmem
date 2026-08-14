# AGENTS.md

This file is the development and contribution contract for AI coding agents working in this repository.

## Project purpose

`tiddlynmem` imports tiddlers from one Node.js TiddlyWiki into Nowledge Mem. It boots the real Wiki with the npm `tiddlywiki` package, renders WikiText to HTML, converts that HTML to GitHub Flavored Markdown, and upserts each result through the selected Nowledge Mem REST API.

`README.md` is the user-facing source of truth for installation and usage. Keep it synchronized whenever CLI behavior changes.

## Non-negotiable behavior

- The current working directory is the only Wiki input.
- The command must be run from a directory containing a readable `tiddlywiki.info`.
- Do not restore `--wiki`, hardcoded Wiki names, parent-directory scans, or sibling-directory scans.
- The CLI uses Terraform-style `plan` and `apply` commands. Omitting the command defaults to `plan`.
- Only the `apply` command may write to Nowledge Mem or modify source tiddlers. After a specific Memory write succeeds, append `$:/NowledgeMem` to that source tiddler without changing its text or duplicating the tag.
- Treat `$:/NowledgeMem` as an imported marker and classify matching source tiddlers as `skipped:imported` before conversion or Memory API writes.
- When `--tag <tag>` is present, filter exact matching tiddlers inside the TiddlyWiki worker before WikiText rendering. Only matching records enter scanning, reporting, classification, conversion, preview, or import. Normal safety classification still applies after this input filter.
- Never tag plan-only, skipped, conversion-failed, render-failed, or Memory-API-failed tiddlers. Never move or delete source tiddlers.
- Do not require the `nmem` CLI at runtime. Both `plan` and `apply` must work without it.
- Resolve the REST API URL in this order: `--api-url`, `NMEM_API_URL`, then `http://127.0.0.1:14242`.
- Check the selected service's `/health` endpoint directly before writing.
- Accept any explicitly selected HTTP or HTTPS endpoint without an additional confirmation flag.
- Read REST credentials only from `NMEM_API_KEY`, send them as Bearer authentication, never pass them to TiddlyWiki workers, and never log them.
- Never follow HTTP redirects for health checks or Memory writes. Users must configure the final Nowledge Mem API URL directly.
- Preserve deterministic Memory IDs based on a collision-resistant Wiki identity and tiddler title so reruns remain idempotent. The default identity combines the Wiki directory name with a resolved-path fingerprint; `--wiki-id` provides an explicit portable override.
- Preserve Unicode in source-Wiki labels and use a deterministic fallback when the normalized Wiki name contains no letters or numbers.
- Preserve the default sensitive-title filter unless a deliberate behavior change includes tests and README updates.

## Language and runtime

- TypeScript everywhere.
- Do not add `.js` or `.mjs` source files.
- Run TypeScript directly with [Nub](https://github.com/nubjs/nub); do not use Bun.
- Keep `@nubjs/nub` as a development dependency for source execution and package builds.
- Keep `strict` TypeScript enabled.
- Use ESM imports with explicit `.ts` extensions, matching the existing codebase.
- Prefer small functions and declarative data transformations over unnecessary classes.
- Do not add a dependency when the Node.js standard library or an existing dependency is sufficient.

## Repository map

- `src/cli.ts`: CLI orchestration, current-directory validation, reporting, previews, and concurrent imports.
- `src/core.ts`: tiddler classification, metadata, stable IDs, HTML-to-Markdown conversion, and media warnings.
- `src/tiddlywiki-worker.ts`: boots TiddlyWiki and sends records over IPC.
- `src/tiddlywiki-tag-worker.ts`: boots TiddlyWiki after successful imports and persists the source marker tag.
- `src/tiddlywiki.ts`: owns read and tag worker lifecycles, IPC validation, and diagnostics.
- `src/nmem.ts`: resolves and validates the selected service URL, checks REST health, and posts native Memory requests.
- `src/options.ts`: parses supported command-line options.
- `scripts/build-package.ts`: compiles the npm package and changes only the generated CLI shebang from Nub to Node.
- `test/`: Node test runner coverage and a minimal TiddlyWiki fixture.
- `dist/`: generated npm package output; ignored, never edited, and never committed.
- `reports/`, `previews/`: generated output; both are ignored and must not be committed.

## npm CLI contract

- The npm package name is `tiddlynmem`.
- The executable name is `tiddlynmem`, mapped to generated `dist/cli.js` through `package.json#bin`.
- Source and build scripts remain TypeScript and run directly with Nub during development.
- `npm prepack` must type-check, test, and generate `dist/`; the generated JavaScript is package output, not source.
- `npm prepack` must also start the generated CLI under plain Node through `npm run check:package`.
- Do not hand-edit or commit generated `.js` files, and do not add a handwritten `.js` or `.mjs` launcher.
- The published package must not depend on Nub at runtime; plain Node executes the generated CLI.
- The default report belongs to the current Wiki and is written under `.tiddlynmem/reports/`.
- Every report entry must include the complete source tiddler tag list for ready, skipped, and failed states. Do not include tiddler bodies in reports.
- Never include raw Nowledge Mem API response bodies in errors or reports.
- Treat a Memory write as successful only when the native response contains `memory.id` matching the requested deterministic ID. Malformed or mismatched success responses must not trigger source tagging.
- Keep npm package metadata, CLI help, README commands, and tests synchronized with the package and executable names.
- Keep `plan` as the default command and `apply` as the only mutating command. Do not restore the legacy `--apply` flag.
- Keep `--tag` as a single exact, case-sensitive input filter unless a deliberate CLI contract change updates tests and documentation.
- Keep `--wiki-id` as the portable Wiki identity override, and expose its resolved value in report options and native Memory metadata.
- Keep `-V` and `--version` available outside a TiddlyWiki directory, with the value read from the installed `package.json`.
- Preserve the historical `tiddlywiki-nmem-importer` string used by `stableMemoryId`; it is an ID compatibility namespace, not the current product name. Changing it would duplicate previously imported Memories.

## Architecture constraints

Keep TiddlyWiki execution in the child worker. TiddlyWiki boot diagnostics must not be mixed with structured tiddler records; records travel through IPC and stderr is collected separately.

During `apply`, scan and classify the Wiki before checking Nowledge Mem health. Skip the health check when no tiddlers are ready. If preflight fails, send no Memory requests, mark ready report entries as `failed:preflight`, write the report, and exit unsuccessfully.

Source tagging is a post-import phase. Collect only titles whose Memory REST request succeeded, send titles over IPC instead of command-line arguments, and persist tags serially through TiddlyWiki's file serializer. On later scans, classify an existing `$:/NowledgeMem` tag as `imported` and skip it; the tag worker still treats an existing marker as success to remain race-safe. Only rewrite regular `application/x-tiddler` files or independently editable files with an existing `.meta` sidecar; fail safely for shared or unsupported formats. A tag failure must be visible in the report and produce an unsuccessful exit without misreporting the already completed Memory write.

Conversion behavior is type-dependent:

- `text/vnd.tiddlywiki` and the empty/default type are rendered by TiddlyWiki before Turndown conversion.
- `text/markdown` retains its source Markdown after media safety processing; `text/plain` uses its source text directly.
- Unsupported binary types, system tiddlers, drafts, previously imported tiddlers, empty tiddlers, and sensitive-title tiddlers are classified and reported instead of imported.

Memory content is the converted Markdown body without importer front matter. Sanitize embedded data-URI images in inline Markdown images, full/collapsed/shortcut reference images, and raw HTML images with quoted or unquoted `src` attributes. Report preserved local image references as warnings. Map every source tag to a native Memory label, and preserve Wiki identity, source Wiki, original title, exact tags, created time, and modified time in the native Memory `metadata` object. Use `source: "tiddlywiki"` and `source_app: "tiddlynmem"`. Nowledge Mem owns its lifecycle `created_at` and `updated_at`; do not misuse event dates as source-file timestamps.

Validate native Memory request limits during `plan`: title length is at most 200 Unicode characters and content length is at most 32,768 Unicode characters. Report a validation failure instead of truncating, splitting, or sending an invalid request. Retry only transient network failures, request timeouts, HTTP 408, HTTP 429, and HTTP 5xx responses. Bound workers and HTTP calls with timeouts.

Send Memory content only in the REST request body. Do not place note content or API credentials in command-line arguments or logs.

## Setup

```bash
mise trust && mise install
npm ci
```

The repository pins its Node, Nub, npm package, and TypeScript toolchain through `mise.toml`, `package.json`, and `package-lock.json`. Nowledge Mem is an external REST service and its CLI is not a project dependency.

## Required validation

Run these commands after every source or test change:

```bash
npm run typecheck
npm test
npm run build
npm run check:package
```

For CLI behavior involving Wiki discovery or rendering, also run `plan` from `test/fixtures/wiki` or another disposable Wiki root. Never run `apply` against the user's real Nowledge Mem in tests or validation unless the user explicitly authorizes those writes; apply tests must use a disposable fake API.

Tests must cover behavior, not implementation details. Add or update tests when changing:

- CLI options and defaults
- exact tag input filtering with and without `--tag`
- tag filtering before WikiText rendering
- tiddler classification
- WikiText/HTML/Markdown conversion
- deterministic IDs or metadata
- default and explicit portable Wiki identities, including same-named Wiki directories
- API URL precedence, direct service health checks, remote endpoint support, and REST request fields
- native title/content limits, transient retry classification, and request timeouts
- Markdown data-URI omission and local-media warnings
- worker IPC and multiline content
- worker credential isolation and apply preflight reporting
- post-import source tagging, idempotence, and source-text preservation
- npm package name, executable mapping, and packed CLI startup

Every GitHub Actions `uses:` reference must be pinned to a full commit SHA with the readable action version in an inline comment.

## Contribution workflow

1. Read `README.md`, this file, and the source files relevant to the requested behavior.
2. Inspect the repository for all references before changing a public option, report field, ID algorithm, label, or conversion rule.
3. Keep the patch scoped to the request and preserve unrelated user changes.
4. Update tests and user documentation in the same change when behavior changes.
5. Run typecheck and the full test suite.
6. Review the final diff for generated files, note content, credentials, and accidental dependency changes.
7. Do not commit, push, publish, or create a pull request unless the user explicitly asks.

## Release workflow

- Use Semantic Versioning. For npm version `X.Y.Z`, use `vX.Y.Z` as the corresponding Git tag and GitHub Release name.
- Update `CHANGELOG.md` before a release and keep an empty `Unreleased` section above the released version.
- Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:package`, and `npm publish --dry-run` from a clean checkout of the release commit.
- The first npm publication must be performed interactively by an npm maintainer with account-level 2FA because npm requires a package to exist before a Trusted Publisher can be configured.
- After the first publication, configure npm Trusted Publishing for a pinned GitHub Actions workflow and use OIDC instead of storing a long-lived npm publish token.
- While the GitHub repository is private, npm Trusted Publishing remains available but npm provenance cannot be generated.
- Never publish, create a tag, create a GitHub Release, or change repository visibility without explicit user authorization.

## Documentation contract

Every project must contain both files:

- `README.md`: written for human users, centered on setup and practical usage.
- `AGENTS.md`: written for AI coding agents, centered on architecture, development constraints, validation, and contribution.

End every repository README with author information and a License section. Add an Acknowledgements section before them when people, projects, or communities deserve credit.

Use Apache-2.0 as the default license for this and future user-owned projects unless the user explicitly selects another license or an existing project has a deliberate incompatible licensing decision. Keep `LICENSE`, package metadata, README attribution, and acknowledgements synchronized.

When project behavior changes, update the relevant sections rather than allowing either document to become historical or aspirational.
