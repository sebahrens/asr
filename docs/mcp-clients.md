# MCP Client Configuration

Copy-paste configuration for connecting MCP-compatible clients to the ASR registry. Blocks below are sourced verbatim from [specs/mcp.md](../specs/mcp.md#client-configuration).

## Getting a token

`ASR_TOKEN` is the bearer token MCP clients send to the registry. It is produced by `asr login` (device-code flow against Microsoft Entra ID; see [specs/cli-integration.md](../specs/cli-integration.md) and tracked under `asr-dul`). After `asr login` succeeds, export the token into your shell environment so the configuration snippets below can reference it:

```bash
export ASR_TOKEN="$(asr token)"
```

In dev mode the server skips token validation, so the dev-mode block intentionally omits the `Authorization` header.

## Claude Code

**Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "skill-registry": {
      "transport": "http",
      "url": "https://api.asr.example.com/mcp",
      "headers": { "Authorization": "Bearer ${ASR_TOKEN}" }
    }
  }
}
```

## Codex CLI

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.skill-registry]
transport = "http"
url = "https://api.asr.example.com/mcp"
bearer_token_env_var = "ASR_TOKEN"
```

## Dev mode

**Dev mode**:

```json
{
  "mcpServers": {
    "skill-registry": { "transport": "http", "url": "http://localhost:3001/mcp" }
  }
}
```
