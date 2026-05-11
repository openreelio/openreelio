# OpenReelio Agent Rules

- Treat OpenReelio as an event-sourced video editing IDE.
- Use the `openreelio` MCP server for project context.
- Start with `openreelio.host.context`.
- Validate command payloads with `openreelio.command.validate`.
- Validate multi-step plans with `openreelio.plan.validate`.
- Do not mutate project state directly.
- Apply edits only through `openreelio.plan.apply` when OpenReelio provides a non-expired approval token.
- Do not claim edits were applied until OpenReelio returns a successful apply result.
