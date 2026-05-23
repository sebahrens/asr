# CLI Integration

## Overview

The Agent Skills Registry distributes skills to AI coding agents via three channels:
1. **MCP Server** — real-time tool interface for search/info/download-url; see [mcp.md](mcp.md).
2. **Marketplace repos** — native plugin distribution for Claude Code and Codex.
3. **Direct CLI** — `asr` command for manual skill management.

This document covers (2) and (3). MCP is fully specified separately.

## ASR CLI

The `asr` command is a single bundled ESM file distributed via Forgejo Releases (see [DESIGN.md](../DESIGN.md)). No npm dependency on end-user machines.

### Commands

```
asr login                            Authenticate via Entra ID device code flow
asr logout                           Clear cached tokens
asr whoami                           Show signed-in identity + roles

asr search <query>                   Search registry
asr info <owner/skill>               Show skill details
asr versions <owner/skill>           List versions (yanked marked, latest highlighted)

asr install <owner/skill>            Install latest non-yanked version
asr install <owner/skill>@<version>  Install specific version (refuses yanked)
asr install --global ...             Install to user scope instead of project
asr install --agent claude|codex|both ...   Force target agent

asr update [<owner/skill>]           Bump to latest non-yanked; prints diff summary
asr remove <owner/skill>             Remove installed skill
asr list                             List installed skills (project + global)

asr publish [<dir>]                  Submit current (or named) directory as a skill
asr publish --watch                  Submit and stream status until terminal
asr status <submission-id>           Check submission status
asr submissions                      List your submissions

asr yank <owner/skill>@<version>     Compliance-only; requires --reason
```

### Authentication

#### Device Code Flow (RFC 8628)

For enterprise environments with Entra ID:

```
$ asr login
To sign in, visit https://microsoft.com/devicelogin
Enter code: ABCD-EFGH
Waiting for authentication... done.
Logged in as user@company.com (roles: Submitter)
Token cached in OS keyring.
```

Polling cadence: 5s interval, max 15 minutes (configurable via `ASR_DEVICE_POLL_INTERVAL_SECONDS`, `ASR_DEVICE_POLL_TIMEOUT_SECONDS`). On rate-limit response, the CLI doubles the interval up to 30s.

#### Token Storage

| Platform | Storage |
|----------|---------|
| macOS | Keychain (`keytar` → `security`) |
| Linux | `libsecret` if available; else `~/.config/asr/token.json` (mode 0600) |
| Windows | Credential Manager (`keytar` → `wincred`) |

Refresh tokens stored alongside; on access-token expiry, the CLI attempts silent refresh, then falls back to device code.

#### Token Export for MCP

MCP clients read `${ASR_TOKEN}` from env. The CLI does **not** ship an `asr token` command that prints the raw access token to stdout — printing tokens to stdout leaks them into shell history, screen recorders, and CI logs.

Instead:

```bash
# Recommended (no leakage to history/recorders):
eval "$(asr token --export)"        # writes: export ASR_TOKEN=...
# or write a sourced env file:
asr token --write-env ~/.asr/env    # mode 0600

# A short-lived (5-minute) token for one command:
ASR_TOKEN=$(asr token --once) some-mcp-client
```

`--once` mints a derived, short-lived token via the API; `--export` emits a shell-escaped assignment that disappears with the eval'd subshell. The base `asr token` with no flags prints nothing and exits 64 (incorrect usage).

#### Dev Mode

When `ASR_URL` points to `http://localhost:*` (any non-HTTPS URL), auth is skipped entirely. Tokens are not requested and not stored.

### Skill Installation Targets

The CLI detects the agent environment and installs to the correct location:

| Agent | Project scope | User scope |
|-------|---------------|------------|
| Claude Code | `.claude/skills/{name}/` | `~/.claude/skills/{name}/` |
| Codex | `.codex/skills/{name}/` | `~/.codex/skills/{name}/` |
| Both | Installs to both (separate copies, not symlinks) | Installs to both |

Detection order: explicit `--agent` flag → `.claude/` or `.codex/` directory present in cwd → both. The CLI also maintains `.agent/asr.lock.json` with installed-skill metadata (version, content-hash, install timestamp, source registry URL) for `asr update` and `asr list`.

After an install, the CLI verifies the downloaded zip's canonical SHA-256 matches the `contentHash` returned by the registry; mismatch aborts the install and emits a `version.hash.mismatch` warning to stderr.

## Skill Format

Skills published to the registry must include:

```
skill-name/
├── SKILL.md              (required — instructions with YAML frontmatter)
├── manifest.yaml         (required — metadata, version, permissions)
├── scripts/              (optional — executable code, triggers approval)
│   └── *.ts|py|sh
├── references/           (optional — context documents)
│   └── *.md
└── CHANGELOG.md          (optional)
```

### manifest.yaml

```yaml
name: code-review
version: 1.2.0
author: security-team
description: Security-focused code review with OWASP checks
tags: [security, review, code-quality]

kind: skill                   # "skill" | "persona"
persona_mode: inject          # required iff kind: persona; "inject" | "delegate"

entrypoint: SKILL.md

permissions:
  network: false
  filesystem: read-own        # "none" | "read-own" | "read-write-own"
  subprocess: false
  environment: []

compatibility:
  claude-code: ">=1.0.0"
  codex: ">=0.9.0"
```

The canonical schema lives in [types.md](types.md#skill-manifest) and is validated server-side. The CLI also validates locally before `asr publish` to fail fast.

### kind and persona_mode

| kind | Description |
|------|-------------|
| `skill` | On-demand instructions found via search. Used when relevant. |
| `persona` | Behavioral overlay that shapes the agent's identity and approach. |

For personas, `persona_mode` controls how the CLI installs it:

| persona_mode | Claude Code | Codex |
|-------------|-------------|-------|
| `inject` | Always-active skill (`when_to_use: always`) | Always-active skill |
| `delegate` | Subagent launcher skill (`allowed-tools: Agent`) | Subagent launcher |

**Default**: `inject`.

**When to use `delegate`**:
- Multi-turn autonomous work
- Needs isolation from main conversation context
- Should produce a deliverable without polluting chat

### SKILL.md Frontmatter

```yaml
---
description: Review code for security vulnerabilities
argument-hint: "[file or PR number]"
allowed-tools: Read, Grep, Bash(readonly)
when_to_use: Use when reviewing code changes for security issues
user-invocable: true
---
```

### Generated SKILL.md for Personas

When `asr install` writes a persona to the filesystem, it generates the SKILL.md from the manifest + content.

#### inject mode → Always-active skill

```yaml
---
description: Expert financial analysis with XLSX tools
when_to_use: always
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
user-invocable: true
disable-model-invocation: false
---

You are a senior financial analyst specializing in...
```

`when_to_use: always` loads the skill into every conversation in that scope.

#### delegate mode → Subagent launcher

```yaml
---
description: Deep research with multi-source synthesis
argument-hint: "<research question>"
allowed-tools: Agent, Read, WebSearch, WebFetch
when_to_use: Use when the user needs deep research across multiple sources
user-invocable: true
---

When invoked, delegate to a focused research subagent:
...
```

### Tool Filter Mapping

Personas may restrict tool access. The mapping table from upstream tool names (some inherited from prior platforms) to Claude Code / Codex equivalents lives in `@asr/cli/tool-mapping.ts` and is unit-tested. Tools without a direct mapping translate to their closest pair (e.g. file-oriented tools → `Read` + `Write` + `Bash`).

### Persona References

Delegate personas may reference other skills:

```yaml
references:
  - code-review
  - financial-analyst
```

When generating the delegate SKILL.md, referenced skills appear in the subagent prompt template. Cycle detection: the CLI rejects references that form a cycle (`A → B → A`) at publish time with `invalid_manifest`.

## Marketplace Distribution

A Git repository (hosted on Forgejo) acts as a marketplace source. The submission service regenerates the marketplace repo on every publish + yank via the `marketplaceSync` job ([submission-package.md](submission-package.md#module-layout)).

### Repo Structure

```
skill-marketplace/
├── marketplace.json
└── plugins/
    └── {skill-name}/
        ├── .claude-plugin/
        │   └── plugin.json
        ├── .codex-plugin/
        │   └── plugin.json
        └── skills/
            └── {skill-name}/
                └── SKILL.md
```

`marketplace.json` is the `MarketplaceManifest` from [types.md](types.md#marketplace-manifest).

Users add the marketplace:

```
/plugin marketplace add forgejo.example.com/org/skill-marketplace
```

### Sync Job

Triggers:
1. Workflow `publish` node fires `version.published` audit event.
2. `version.yanked` audit event.

Behaviour:
1. Read `registry.json` from the registry repo.
2. Regenerate `marketplace.json` and per-plugin files.
3. Open a PR against the marketplace repo (separate from the registry repo) with the same merge-bot identity; auto-merge if CI passes.
4. On any failure, emit `marketplace_sync.failed` audit event and page on-call (rate-limited to one alert per hour per skill).

The marketplace repo is read-only to end users; only the merge bot writes to it.
