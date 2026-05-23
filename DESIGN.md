# ASR CLI — Distribution & Publish Approval Design

## Goal

Enable local download of the CLI binary from Forgejo Releases — no global npm registry, no `npx`.

## Distribution Architecture

```
┌─────────────┐     tag push      ┌──────────────────┐
│  Developer   │ ───────────────► │  Forgejo Actions  │
│  git tag v*  │                   │  release.yml      │
└─────────────┘                   └────────┬─────────┘
                                           │ builds bundle
                                           ▼
                                  ┌──────────────────┐
                                  │  Forgejo Release  │
                                  │  asset: asr.mjs   │
                                  └────────┬─────────┘
                                           │ curl / install.{sh,ps1}
                                           ▼
                                  ┌──────────────────┐
                                  │  User machine     │
                                  │  per-OS bin dir   │
                                  └──────────────────┘
```

## Build Strategy

- `tsup` bundles CLI + all workspace deps (`@asr/core`) + node_modules into a single ESM file
- Output: `dist/asr.mjs` (~500KB, self-contained, runs with `node >= 20`)
- No native dependencies — pure JS
- Same artefact for all OSes; the install scripts only differ in how they wire up the launcher script

## Install Scripts

Two scripts are published as Release assets alongside `asr.mjs`. Both pin to a release version (or `latest`) and verify the artefact's SHA-256 against `asr.mjs.sha256` from the same Release before installing.

### `scripts/install.sh` (POSIX shells: macOS, Linux)

```bash
#!/bin/sh
set -e
FORGEJO_URL="${ASR_FORGEJO_URL:-https://forgejo.example.com}"
REPO="org/aks"
VERSION="${1:-latest}"
DEST="${ASR_INSTALL_DIR:-$HOME/.local/bin}"

if [ "$VERSION" = "latest" ]; then
  ASSET_BASE="$FORGEJO_URL/$REPO/releases/latest/download"
else
  ASSET_BASE="$FORGEJO_URL/$REPO/releases/download/$VERSION"
fi

mkdir -p "$DEST"
curl -fsSL "$ASSET_BASE/asr.mjs" -o "$DEST/asr.mjs"
curl -fsSL "$ASSET_BASE/asr.mjs.sha256" -o "$DEST/asr.mjs.sha256"

EXPECTED=$(cut -d' ' -f1 < "$DEST/asr.mjs.sha256")
ACTUAL=$(shasum -a 256 "$DEST/asr.mjs" | cut -d' ' -f1)
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "SHA-256 mismatch: expected $EXPECTED got $ACTUAL" >&2
  rm -f "$DEST/asr.mjs" "$DEST/asr.mjs.sha256"
  exit 1
fi
rm "$DEST/asr.mjs.sha256"

printf '#!/bin/sh\nexec node "%s/asr.mjs" "$@"\n' "$DEST" > "$DEST/asr"
chmod +x "$DEST/asr"
echo "Installed asr to $DEST/asr"
echo "Make sure $DEST is on your PATH."
```

### `scripts/install.ps1` (Windows PowerShell 5.1+ / PowerShell 7+)

```powershell
$ErrorActionPreference = 'Stop'
$ForgejoUrl = $env:ASR_FORGEJO_URL; if (-not $ForgejoUrl) { $ForgejoUrl = 'https://forgejo.example.com' }
$Repo       = 'org/aks'
$Version    = if ($args.Count -gt 0) { $args[0] } else { 'latest' }
$Dest       = if ($env:ASR_INSTALL_DIR) { $env:ASR_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\asr' }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$Base = if ($Version -eq 'latest') {
  "$ForgejoUrl/$Repo/releases/latest/download"
} else {
  "$ForgejoUrl/$Repo/releases/download/$Version"
}

Invoke-WebRequest "$Base/asr.mjs"          -OutFile (Join-Path $Dest 'asr.mjs')
Invoke-WebRequest "$Base/asr.mjs.sha256"   -OutFile (Join-Path $Dest 'asr.mjs.sha256')

$Expected = (Get-Content (Join-Path $Dest 'asr.mjs.sha256')).Split(' ')[0]
$Actual   = (Get-FileHash (Join-Path $Dest 'asr.mjs') -Algorithm SHA256).Hash.ToLower()
if ($Expected -ne $Actual) {
  Remove-Item -Force (Join-Path $Dest 'asr.mjs'), (Join-Path $Dest 'asr.mjs.sha256')
  throw "SHA-256 mismatch: expected $Expected got $Actual"
}
Remove-Item -Force (Join-Path $Dest 'asr.mjs.sha256')

@"
@echo off
node "%~dp0asr.mjs" %*
"@ | Set-Content -Path (Join-Path $Dest 'asr.cmd') -Encoding ASCII

Write-Host "Installed asr to $Dest\asr.cmd"
Write-Host "Add $Dest to your PATH if it isn't already."
```

## Release Workflow (`.forgejo/workflows/release.yml`)

Triggers on `v*` tags. Steps:
1. Checkout + pnpm install
2. `pnpm build` (tsup produces `packages/cli/dist/asr.mjs`)
3. Compute SHA-256, write `asr.mjs.sha256`
4. Create Forgejo Release via the Forgejo REST API (`POST /api/v1/repos/:o/:r/releases`)
5. Upload `asr.mjs`, `asr.mjs.sha256`, `install.sh`, `install.ps1` as release assets

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable && pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Compute SHA-256
        run: |
          cd packages/cli/dist
          sha256sum asr.mjs > asr.mjs.sha256
      - name: Create release via Forgejo API
        env:
          FORGEJO_TOKEN: ${{ secrets.FORGEJO_RELEASE_TOKEN }}
          FORGEJO_URL:   ${{ secrets.FORGEJO_URL }}
          REPO:          ${{ secrets.RELEASE_REPO }}     # owner/repo
        run: |
          TAG=${GITHUB_REF#refs/tags/}
          # 1) create release
          RID=$(curl -fsS -X POST \
            -H "Authorization: token $FORGEJO_TOKEN" \
            -H "Content-Type: application/json" \
            "$FORGEJO_URL/api/v1/repos/$REPO/releases" \
            -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\"}" \
            | jq -r .id)
          # 2) upload each asset
          for f in packages/cli/dist/asr.mjs packages/cli/dist/asr.mjs.sha256 scripts/install.sh scripts/install.ps1; do
            curl -fsS -X POST \
              -H "Authorization: token $FORGEJO_TOKEN" \
              -F "attachment=@$f;filename=$(basename $f)" \
              "$FORGEJO_URL/api/v1/repos/$REPO/releases/$RID/assets"
          done
```

(There is no separate `forgejo-release` CLI in our toolchain; the curl-against-API approach has no extra dependencies and is the documented Forgejo path.)

## Publish Approval Workflow

Skills published to the registry need conditional approval. The full lifecycle lives in [specs/workflow.md](specs/workflow.md). Summary:

### Rules

| Skill contents | Approval required? |
|---------------|--------------------|
| Only `.md` / `.png` / etc. (whitelist) | No — auto-approve, but still goes through Forgejo PR + merge for traceability |
| Contains `scripts/` with TS/Python/Go/etc. | Yes — questionnaire → scan → user confirm → compliance approval |

### Flow

```
[Submit Skill] → [Classify Content] → [Push to Forgejo (always)]
                                         │
                              ┌──────────┴───────────┐
                              │                      │
                        md-only path           code path
                              │                      │
                              ▼                      ▼
                       [Auto-approve]         [Questionnaire]
                              │                      ▼
                              │              [Container Scan]
                              │                      ▼
                              │              [User Confirms]
                              │                      ▼
                              │              [Compliance Review]
                              ▼                      │
                       [Merge PR + Publish] ◄────────┘
```

### Content Classification

On `asr publish`, the CLI inspects the skill directory:
- Glob for any file not in the content-only whitelist defined in [specs/security.md](specs/security.md#classification-whitelist-approach)
- If matches found → mark as `requires_approval`
- Otherwise → MD-only path (still creates PR and merges, no human approver)

### Approval Backend

- **Workflow engine**: Flowcraft with HITL nodes for human-in-the-loop steps
- **Git-backed review**: PR in Forgejo `skills-registry` repo with branch protection
- **Registry API**: status tracking with the canonical `SubmissionStatus` union from [specs/types.md](specs/types.md#submission)
- **Separation of duties**: submitter ≠ approver, submitter ≠ yanker; enforced via Entra ID `sub` claim

## CLI Authentication

OAuth 2.0 Device Authorization Grant via Entra ID. Full UX in [specs/cli-integration.md](specs/cli-integration.md#authentication).

```bash
$ asr login
To sign in, visit https://microsoft.com/devicelogin
Enter code: ABCD-EFGH

Waiting for authentication... done.
Logged in as user@company.com
```

Tokens cached in OS keyring. Refreshed silently on expiry. The CLI never prints the raw access token to stdout — use `asr token --export`, `asr token --write-env`, or `asr token --once` instead (see [specs/cli-integration.md](specs/cli-integration.md#token-export-for-mcp)).

Dev mode: when `ASR_URL` is a non-HTTPS URL (typically `http://localhost:*`), no auth is required.
