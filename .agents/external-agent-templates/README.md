# External Agent MCP Templates

These templates connect MCP-capable agents to OpenReelio's local MCP server.

Set `OPENREELIO_PROJECT_PATH` to an OpenReelio project directory before launching the agent, or replace the placeholder in each template with an absolute project path.

```bash
export OPENREELIO_PROJECT_PATH=/absolute/path/to/project
```

By default the server is read-only. It exposes host context, project metadata, selection defaults, diagnostics, timeline snapshots, assets, command schema, command validation, plan validation, and preview state.

Start the server manually for smoke testing:

```bash
openreelio-cli mcp --stdio --project "$OPENREELIO_PROJECT_PATH"
```

Approved mutation is disabled unless the server process receives a session-scoped token:

```bash
export OPENREELIO_MCP_APPROVAL_TOKEN="$(openssl rand -hex 32)"
export OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS="$(node -e 'console.log(Date.now() + 10 * 60 * 1000)')"
openreelio-cli mcp --stdio --project "$OPENREELIO_PROJECT_PATH"
```

Agents must pass that exact token as `approvalToken` to `openreelio.plan.apply` before `OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS`. Do not place long-lived tokens in shared config files.

Do not expose this server to remote networks. Use local stdio or a vendor-supported remote MCP gateway with explicit user approval.
