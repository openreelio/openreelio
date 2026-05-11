# xAI/Grok Remote MCP Notes

xAI remote MCP integrations are API-driven rather than local subscription-agent bridges.

Use this only after placing OpenReelio MCP behind an explicit, authenticated, user-approved remote gateway. The Phase 1 `openreelio-cli mcp --stdio` server is local-only and should not be exposed directly to a network.

Recommended policy:

- Keep Phase 1 local-only.
- Expose read-only tools first.
- Require per-session approval and short-lived tokens before any mutation gateway.
- Do not transmit raw media, credentials, full filesystem paths, or unrelated project metadata.
