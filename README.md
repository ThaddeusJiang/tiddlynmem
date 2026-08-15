# tiddlynmem

Import TiddlyWiki tiddlers into [Nowledge Mem](https://mem.nowledge.co/) as AI memories.

## Copy to AI

```text
Read https://github.com/ThaddeusJiang/tiddlynmem/blob/main/README.md, then plan and apply the TiddlyWiki import in the current directory.
```

## Run it yourself

Run from the TiddlyWiki root directory:

```bash
npx tiddlynmem plan
npx tiddlynmem apply
```

Review the plan before applying it. All options belong to `plan`; `apply` takes no options and executes that saved plan.

## Common usage

Filter by an exact TiddlyWiki tag:

```bash
npx tiddlynmem plan --tag "Project Alpha"
npx tiddlynmem apply
```

Import a limited batch:

```bash
npx tiddlynmem plan --limit 20
npx tiddlynmem apply
```

Use another Nowledge Mem endpoint:

```bash
export NMEM_API_URL="https://mem.example.com"
export NMEM_API_KEY="nmem_..."
npx tiddlynmem plan
npx tiddlynmem apply
```

The default endpoint is `http://127.0.0.1:14242`. `--api-url` overrides both the default and `NMEM_API_URL`. The `nmem` CLI is not required.

Set a portable Wiki identity when the Wiki may move between paths or computers:

```bash
npx tiddlynmem plan --wiki-id personal-notes
npx tiddlynmem apply
```

## CLI reference

| Command | Description |
| --- | --- |
| `plan` | Preview and save an execution plan; default when omitted |
| `apply` | Apply the saved plan; accepts no plan options |

| Plan option | Description |
| --- | --- |
| `--tag <tag>` | Process one exact, case-sensitive TiddlyWiki tag |
| `--limit <count>` | Process at most this many importable tiddlers |
| `--jobs <count>` | Concurrent writes; default: `4` |
| `--space-id <id>` | Nowledge Mem space; default: `default` |
| `--wiki-id <id>` | Stable portable Wiki identity |
| `--include-sensitive` | Include titles matched by the sensitive-title filter |
| `--api-url <url>` | Nowledge Mem HTTP or HTTPS endpoint |
| `-h`, `--help` | Show help |
| `-V`, `--version` | Show version |

## Import behavior

- Reads only the TiddlyWiki in the current directory.
- Renders WikiText with the active TiddlyWiki runtime and converts it to GitHub Flavored Markdown.
- Keeps Markdown and plain-text tiddlers as text.
- Maps every TiddlyWiki tag to a Memory label.
- Preserves the Wiki identity, source Wiki, title, tags, `created`, and `modified` values in Memory metadata.
- Uses stable Memory IDs so reruns remain idempotent.
- Saves IDs, options, and content fingerprints to `.tiddlynmem/plan.json` without saving tiddler bodies or credentials.
- Rejects `apply` if the Wiki changed after `plan`.
- Omits embedded data-URI images and warns about local image references.
- Skips system tiddlers, drafts, empty content, unsupported binary types, previously imported tiddlers, and sensitive-looking titles.
- Accepts titles up to 200 characters and bodies up to 32,768 characters; invalid entries are reported without truncation.
- Never changes source text. `apply` only adds `$:/NowledgeMem` after the Memory API confirms the requested ID.

## Troubleshooting

`Current directory is not a TiddlyWiki root` means the current directory does not contain a readable `tiddlywiki.info`.

`No saved plan found` or `changed after planning` means you must run and review `npx tiddlynmem plan` again before `npx tiddlynmem apply`.

For `imported:tag-failed`, the Memory already exists but the source marker was not saved. Fix the reported file or permission issue and rerun the same command.

## Development

```bash
git clone https://github.com/ThaddeusJiang/tiddlynmem.git
cd tiddlynmem
mise trust && mise install
npm ci
npm run typecheck
npm test
npm run build
```

Source files are TypeScript and run with [Nub](https://github.com/nubjs/nub). Generated package files are written to the ignored `dist/` directory.

See [AGENTS.md](AGENTS.md) for development and contribution guidance.

## Acknowledgements

Thanks to [TiddlyWiki](https://tiddlywiki.com/), [Turndown](https://github.com/mixmark-io/turndown), [Nub](https://github.com/nubjs/nub), and [Nowledge Mem](https://mem.nowledge.co/).

## Author

[Thaddeus Jiang](https://github.com/ThaddeusJiang)

## License

Copyright 2026 Thaddeus Jiang. Licensed under the [Apache License 2.0](LICENSE).
