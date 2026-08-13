# OpenReelio agent skill package

This directory is the **authoring source** for the `openreelio` agent skill and
plugin. It is written and reviewed here, alongside the CLI it documents, and then
synced to the standalone [`openreelio/skills`](https://github.com/openreelio/skills)
repository, which is what users actually install from.

Nothing here is auto-installed by checking out this repository. The plugin
manifest lives at `distribution/skills/.claude-plugin/plugin.json`, not at the
repository root, so this repo is not itself a plugin or a skills container.

## Layout

```
distribution/skills/
├── .claude-plugin/plugin.json     plugin manifest (name, version, author, license)
├── .mcp.json                      MCP server wiring for openreelio-cli
├── README.md                      this file
└── skills/
    └── openreelio/
        ├── SKILL.md               the installable unit — a router, nothing more
        ├── setup/REFERENCE.md
        ├── perception/REFERENCE.md
        ├── editing/REFERENCE.md
        ├── captions/REFERENCE.md
        ├── render/REFERENCE.md
        └── verify/REFERENCE.md
```

## Authoring rules

These are structural requirements, not style preferences.

1. **`SKILL.md` frontmatter has exactly two fields**: `name` and `description`.
   `name` must equal the containing directory name and match
   `^[a-z0-9]+(-[a-z0-9]+)*$`.
2. **`description` is one capability sentence plus a trigger clause.** It is the
   only thing a host model sees when deciding whether to load the skill.
3. **Sub-topic files are named `REFERENCE.md`, never `SKILL.md`.** A nested
   `SKILL.md` would be discovered as a separate skill (or, worse, silently
   ignored), which is not what a router-and-topics layout means.
4. **`SKILL.md` is a router.** Each topic gets an `## Heading`, one sentence
   naming the trigger, and a link to its `REFERENCE.md`. Detail belongs in the
   reference file, which is loaded only when the topic is relevant.
5. **Every command and flag must exist.** Cross-check against
   `openreelio-cli help-json` or `openreelio-cli <verb> --help` before writing it
   down. The CLI is self-describing; this package exists to orient an agent, not
   to replace the binary's own help.
6. **Keep each `REFERENCE.md` under about 150 lines.** If a topic outgrows that,
   split it into a new topic and add a router entry.

## MCP server

`.mcp.json` starts `openreelio-cli mcp --stdio` against `${CLAUDE_PROJECT_DIR}`.
`--stdio` is required — without it the command prints a discovery payload and
exits instead of serving.

The server is **read-only by default**. Mutating tools (`openreelio.media.insert`,
`openreelio.plan.apply`) appear only when the operator adds `--allow-write` — a
local-trust switch that drops the per-call approval requirement — or when the
host supplies `OPENREELIO_MCP_APPROVAL_TOKEN` for a single call. Editing through
the CLI verbs described in the skill needs neither.

If your host does not substitute `${CLAUDE_PROJECT_DIR}`, replace it with an
absolute project directory, or drop `--project` and pass the project path to each
CLI call instead.

## Sync

Changes here are mirrored to `openreelio/skills` as part of a release. Edit here;
do not edit the published copy directly.

## License

MIT © 2026 Junseo5
