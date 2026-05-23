# MCP Server

The registry exposes a Model Context Protocol server at `/mcp` on the API service. Implements the Streamable HTTP transport (MCP spec 2025-06-18 or later).

## Transport

- Protocol: MCP **Streamable HTTP** (single endpoint, server-sent events for tool output, JSON for request).
- Endpoint: `POST /mcp` for tool invocations, `GET /mcp` for the SSE result stream associated with a session id.
- Session id: server-issued opaque token in `Mcp-Session-Id` header on the initial response; client echoes it on subsequent requests.
- Protocol version: server advertises `2025-06-18` in the `initialize` response; rejects older clients with `unsupported_protocol_version`.

## Authentication

The MCP server reuses Entra ID bearer tokens — the **same** validation middleware as the REST API (see [api.md](api.md#authentication--authorization)).

| Header | Meaning |
|--------|---------|
| `Authorization: Bearer <jwt>` | Required for any non-public tool. Token must include `access_as_user` scope and at least the `Submitter` role. |
| `Mcp-Session-Id: <session>` | Required after the initial `initialize`. Bound to the principal of the token used at `initialize`. |

The MCP server **does not** issue its own tokens. Tokens are obtained via `asr login` (device code flow) and exported as `ASR_TOKEN` for client configs.

Dev mode: when the API runs with `AUTH_MODE=mock`, the MCP server skips token validation and injects the mock principal.

## Tool Inventory

All tools are **read-only** from the user's machine perspective — they never write to the user's filesystem. The CLI is responsible for actual install/download; MCP tools return URLs, manifests, or metadata that the client can act on.

| Tool | Required role | Purpose |
|------|---------------|---------|
| `registry_search` | Submitter | Search published skills |
| `registry_info` | Submitter | Manifest + versions for one skill |
| `registry_list` | Submitter | List skills with filters |
| `registry_versions` | Submitter | All non-yanked versions for a skill |
| `registry_download_url` | Submitter | Returns the signed download URL for a specific version (client does the install) |
| `submissions_mine` | Submitter | List the caller's own submissions + statuses |
| `submission_status` | Submitter | Detail for one of the caller's submissions |
| `review_queue` | Compliance | List pending compliance reviews |
| `review_decision` | Compliance | Approve or reject (mutating — guarded by separation-of-duties) |

Per-tool role enforcement is performed inside the MCP tool handler, not by transport-level middleware, so an authenticated `Submitter` calling `review_decision` receives `403 insufficient_permissions` in the MCP error envelope.

## Error Envelope

MCP error responses use the standard JSON-RPC error object with an ASR-specific `data` payload:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32001,
    "message": "insufficient_permissions",
    "data": { "required": "Compliance", "actual": ["Submitter"] }
  }
}
```

| Code | Meaning |
|------|---------|
| `-32001` | insufficient_permissions |
| `-32002` | authentication_required |
| `-32003` | resource_not_found |
| `-32004` | version_yanked (returned by `registry_download_url`) |
| `-32005` | rate_limited (includes `retryAfterSeconds`) |
| `-32006` | audit_chain_broken (mirrors REST `503`) |
| `-32099` | internal_error (no leak of internals; trace id in `data`) |

## Tool Definitions

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

server.tool('registry_search', {
  description: 'Search the registry for skills by keyword, tag, kind, or author.',
  inputSchema: {
    query: z.string().optional(),
    tag: z.array(z.string()).optional(),
    author: z.string().optional(),
    kind: z.enum(['skill','persona']).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  },
});

server.tool('registry_download_url', {
  description:
    'Returns a download URL plus expected content hash for a specific version. ' +
    'The client must download, verify the SHA-256 matches, then extract. Yanked versions return an error.',
  inputSchema: {
    owner: z.string(),
    name: z.string(),
    version: z.string().optional(), // default: latest non-yanked
  },
  // Output:
  // { url: string, contentHash: 'sha256:...', sizeBytes: number, manifest: SkillManifest, expiresAt: string }
});

server.tool('review_decision', {
  description: 'Approve or reject a submission (Compliance role only).',
  inputSchema: {
    submissionId: z.string(),
    decision: z.enum(['approve','reject']),
    reason: z.string().optional(),
  },
});
```

## Rate Limiting

Mirrors the registry API rate limits per principal (see [registry-api.md](registry-api.md#rate-limiting)). Mutating tools (`review_decision`) are capped at 60/min/sub.

## Client Configuration

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

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.skill-registry]
transport = "http"
url = "https://api.asr.example.com/mcp"
bearer_token_env_var = "ASR_TOKEN"
```

**Dev mode**:

```json
{
  "mcpServers": {
    "skill-registry": { "transport": "http", "url": "http://localhost:3001/mcp" }
  }
}
```

## Telemetry

The MCP server emits structured logs (one line per tool invocation) with:
- `traceId`, `sessionId`, `principalSub`, `tool`, `durationMs`, `outcome`

No tool inputs or outputs are logged (they may contain skill content). Errors include the code from the table above plus a trace id, never raw exceptions.
