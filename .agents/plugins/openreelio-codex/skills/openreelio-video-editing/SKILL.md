---
name: openreelio-video-editing
description: Use OpenReelio MCP tools to inspect video-editing projects, validate command payloads, and propose safe edit plans.
---

# OpenReelio Video Editing

OpenReelio is an event-sourced video editing IDE. Project truth is the command log, not direct state mutation.

## Rules

- Use OpenReelio MCP tools before proposing edits.
- Prefer `openreelio.host.context` first, then `openreelio.timeline.snapshot`, then `openreelio.command.schema`.
- Do not claim an edit was applied unless OpenReelio reports a successful mutating plan result.
- `openreelio.plan.apply` is available only when OpenReelio configures a session-scoped approval token and that token has not expired.
- Never invent or guess approval tokens.
- Propose edits as OpenReelio command payloads or multi-step plans that can be validated.
- Ask for user approval before destructive or broad edits.
- Treat raw media, transcripts, full file paths, and credentials as sensitive.

## Workflow

1. Read host context.
2. Inspect project and timeline state.
3. Read command schema.
4. Draft a plan in structured JSON.
5. Validate commands or the plan.
6. Ask the user to approve mutation.
7. Apply only when OpenReelio provides a non-expired approval token through the active tool call context.
8. Explain remaining risks and results.
