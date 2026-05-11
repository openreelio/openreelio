# DeepSeek, GLM, And Other Model API Notes

DeepSeek, GLM, and similar model APIs should not be treated as local subscription-agent hosts unless they publish a stable local agent runtime or MCP client.

Recommended integration paths:

- Use OpenReelio's existing model-provider architecture for direct API usage.
- Use an MCP-capable agent shell such as OpenCode when the user wants agent behavior.
- Keep OpenReelio MCP tools read-only unless OpenReelio provides a short-lived approval token for a specific plan.
- Do not exchange vendor app credentials for API access.
