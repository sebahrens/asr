# Registry API (read side)

Public, read-only endpoints used by the web UI, the CLI (`asr search/install/info`), and the MCP server. Distinct from the **submission API** ([api.md](api.md)) which is write-mutating.

Base URL: `/api/v1`

## Endpoints

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/health` | Liveness probe | none |
| GET | `/version` | Build sha + spec version | none |
| GET | `/skills` | List/search published skills | optional bearer (used for personalised ranking) |
| GET | `/skills/:owner/:name` | Skill detail (latest + versions[]) | none |
| GET | `/skills/:owner/:name/v/:version` | Pinned-version manifest + SKILL.md | none |
| GET | `/skills/:owner/:name/v/:version/download` | Redirect to Forgejo generic package URL | none |
| GET | `/skills/:owner/:name/versions` | All non-yanked versions, semver-ordered | none |
| GET | `/skills/:owner/:name/versions/:version/diff` | `VersionDiff` against previous version | none |
| GET | `/registry.json` | Cached marketplace index (built on every publish) | none |

All endpoints support `Accept: application/json` only. Errors follow the envelope in [api.md](api.md#error-responses).

## `GET /skills`

Search + filter + paginate.

### Query parameters

| Name | Type | Default | Notes |
|------|------|---------|-------|
| `q` | string | — | Full-text over `name`, `description`, `tags` |
| `tag` | string | — | Repeatable; ANDed |
| `author` | string | — | Exact match on `sub` or `email` |
| `kind` | `skill` \| `persona` | both | |
| `limit` | int | 20 | Max 100 |
| `cursor` | opaque | — | Returned by previous response |

### Response

```json
{
  "items": [
    {
      "name": "code-review",
      "owner": "security-team",
      "latestVersion": "1.2.0",
      "description": "Security-focused code review",
      "tags": ["security","review"],
      "kind": "skill",
      "publishedAt": "2026-05-23T10:00:00Z",
      "downloadCount": 1284,
      "riskAssessmentLatest": "low"
    }
  ],
  "nextCursor": "eyJvZmZzZXQiOjIwfQ=="
}
```

## `GET /skills/:owner/:name`

Returns the canonical skill metadata plus a list of versions (yanked entries included but marked).

```json
{
  "owner": "security-team",
  "name": "code-review",
  "latestVersion": "1.2.0",
  "manifestLatest": { /* SkillManifest */ },
  "versions": [
    { "version": "1.2.0", "publishedAt": "...", "contentHash": "sha256:...", "yanked": false, "approvedBy": "..." },
    { "version": "1.1.0", "publishedAt": "...", "contentHash": "sha256:...", "yanked": true,  "yankReason": "CVE-..." },
    { "version": "1.0.0", "publishedAt": "...", "contentHash": "sha256:...", "yanked": false }
  ],
  "tags": ["security","review"],
  "downloadCount": 1284
}
```

`latestVersion` is computed via `semver.rsort` over non-yanked, non-rejected versions (see [versioning.md](versioning.md#latest-version-resolution)).

## `GET /skills/:owner/:name/v/:version/download`

302 redirect to the Forgejo generic package URL:

```
Location: https://forgejo.internal.../api/packages/{owner}/generic/{name}/{version}/skill.zip
```

The CLI follows the redirect and verifies the downloaded zip's canonical SHA-256 matches `contentHash` from the version metadata before extracting.

Yanked versions: redirect still works (so existing installs can verify), but the response includes `X-ASR-Yanked: true` and the CLI surfaces a warning.

## Caching

- All `GET` responses include `ETag` and `Cache-Control: public, max-age=60`.
- `GET /registry.json` is regenerated on every publish/yank; the file is served from disk (or Azure Files) with `Last-Modified`.
- The web UI honours the cache; the CLI bypasses cache when called with `--no-cache` or `--watch`.

## Rate Limiting

| Endpoint class | Anonymous | Authenticated |
|----------------|-----------|---------------|
| Search / list  | 60 req/min/IP | 600 req/min/sub |
| Detail / version | 600 req/min/IP | 6000 req/min/sub |
| Download redirect | 60 req/min/IP | 600 req/min/sub |

Exceeded: `429 too_many_requests` with `Retry-After` seconds.
