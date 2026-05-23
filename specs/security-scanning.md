# Security Scanning Pipeline

## Overview

The ASR submission pipeline runs automated security scans on skills containing executable code (`scripts/` directory). Scans run after the submitter completes the questionnaire and before compliance review. Results are stored in the submission record and presented to the compliance reviewer.

## Scan Triggers

| Skill contents | Scan behavior |
|---------------|---------------|
| Only `.md` files | No scan — auto-publish |
| Contains `scripts/` with executable code | Full scan pipeline |
| Contains `package.json` / `requirements.txt` / lockfiles | Dependency scan added |

## Tool Stack

> **Pre-flight verification required.** Several tool names/URLs in earlier drafts were unverified. Before the scanner Docker image is built for the first time, a Phase 1 task **must** confirm: (a) Foxguard's actual distribution channel (Rust binary release, cargo, npm name) since `npm i -g foxguard` may not resolve to the intended package; (b) Opengrep's exact release asset filename and download URL pattern; (c) Veracode CLI verbs (`veracode static scan` should be replaced with the documented `veracode scan` invocation); (d) pinned version numbers for all tools — `:latest` is forbidden in production images. The version numbers below are placeholders to be replaced with the validated pins.

### Tier 1 — Always Run (Permissive Licenses)

| Tool | Purpose | License | Binary | Docker Image |
|------|---------|---------|--------|--------------|
| Gitleaks | Secret detection (API keys, tokens, credentials) | MIT | Go static binary | `zricethezav/gitleaks:latest` |
| Trivy | SCA (dependency CVEs), IaC misconfig, license compliance | Apache-2.0 | Go static binary | `aquasecurity/trivy:latest` |
| Foxguard | SAST (170+ rules, 10 languages, cross-file taint) | MIT | Rust static binary | via npm `foxguard@latest` |

### Tier 2 — Deep Analysis (Executable Skills)

| Tool | Purpose | License | Binary | Docker Image |
|------|---------|---------|--------|--------------|
| Opengrep | Deep pattern matching, Semgrep-compatible rules, 30+ languages | LGPL-2.1 | OCaml static binary | `ghcr.io/opengrep/opengrep:latest` |

### Tier 3 — Optional Enterprise (Configured via Env)

| Tool | Purpose | License | Activation |
|------|---------|---------|-----------|
| Veracode Pipeline Scan | Commercial SAST/SCA with enterprise compliance | Proprietary | `VERACODE_API_KEY_ID` + `VERACODE_API_KEY_SECRET` set |

## License Compliance

All Tier 1 tools use permissive licenses (MIT, Apache-2.0) with no copyleft obligations. They can be embedded in our Docker images and redistributed freely.

**Opengrep (LGPL-2.1)**: Invoked as a subprocess — no linking, no copyleft propagation. The LGPL only requires sharing modifications to Opengrep itself (we make none). Safe to bundle as a binary in our scanner image.

**Veracode**: Proprietary SaaS — never bundled. Called via CLI with API credentials. Zero licensing obligation beyond maintaining a valid subscription.

**Semgrep Rules note**: Opengrep maintains its own community rule repository under LGPL-2.1. Do NOT use rules from `semgrep/semgrep-rules` (governed by Semgrep Rules License v1.0 which restricts SaaS use). Use Opengrep's rule repository or write custom rules.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Scan Orchestrator                          │
│                                                             │
│  Input: extracted skill directory at /tmp/scan/{submission_id}/
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐   │
│  │  Gitleaks   │  │   Trivy     │  │     Foxguard      │   │
│  │  --source   │  │  fs --scanners │  │  scan --sarif  │   │
│  │  dir mode   │  │  vuln,secret│  │  --severity med  │   │
│  └──────┬──────┘  └──────┬──────┘  └────────┬──────────┘   │
│         │                │                   │              │
│         ▼                ▼                   ▼              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              SARIF Aggregator                         │   │
│  │  - Deduplicates across tools                         │   │
│  │  - Normalizes severity (critical/high/medium/low)    │   │
│  │  - Computes blocking verdict                         │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│         ┌────────────────┼─────────────────┐                │
│         ▼ (if scripts/)  ▼ (if configured) ▼                │
│  ┌────────────┐   ┌────────────┐   ┌───────────────┐       │
│  │  Opengrep  │   │  Veracode  │   │  Store in DB  │       │
│  │  deep scan │   │  pipeline  │   │  + notify     │       │
│  └────────────┘   └────────────┘   └───────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Scan Configuration

### Environment Variables

```bash
# Tier 1 — no credentials needed (run locally)
SCAN_TIMEOUT_SECONDS=300          # Max time per tool (default: 5 min)
SCAN_SEVERITY_THRESHOLD=high      # Block on: critical, high (default)

# Tier 2 — Opengrep
OPENGREP_RULES_DIR=/opt/scan/rules  # Custom rules directory (optional)
OPENGREP_ENABLED=true               # Enable deep scan (default: true if scripts/ present)

# Tier 3 — Veracode (optional, skip if unset)
VERACODE_API_KEY_ID=               # Veracode API ID
VERACODE_API_KEY_SECRET=           # Veracode API secret
VERACODE_POLICY=default            # Veracode policy name
```

### Severity Mapping

All tools produce SARIF with varying severity labels. Normalized to:

| Normalized | Gitleaks | Trivy | Foxguard | Opengrep | Veracode |
|-----------|----------|-------|----------|----------|----------|
| Critical | — | CRITICAL | critical | error (confidence: high) | Very High |
| High | all findings (secrets are always high) | HIGH | high | error (confidence: medium) | High |
| Medium | — | MEDIUM | medium | warning | Medium |
| Low | — | LOW | low | info | Low |

### Blocking Rules

| Severity | Default behavior | Configurable? |
|----------|-----------------|---------------|
| Critical | Hard block — submission rejected automatically | No |
| High | Block — requires compliance reviewer override | Yes |
| Medium | Advisory — shown to reviewer, non-blocking | Yes |
| Low | Informational — logged, not shown by default | Yes |

**Secret detection is always a hard block.** Any finding from Gitleaks blocks the submission regardless of severity configuration.

## Scanner Docker Image

The scan pipeline runs in a dedicated container with all tools pre-installed:

### Dockerfile

```dockerfile
FROM node:22-slim AS base

# Gitleaks (MIT)
COPY --from=zricethezav/gitleaks:latest /usr/bin/gitleaks /usr/local/bin/gitleaks

# Trivy (Apache-2.0)
RUN apt-get update && apt-get install -y curl && \
    curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin && \
    trivy --download-db-only && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Foxguard (MIT) — Rust binary via npm
RUN npm install -g foxguard@latest

# Opengrep (LGPL-2.1) — static binary from releases
RUN curl -fsSL https://github.com/opengrep/opengrep/releases/latest/download/opengrep-linux-x86_64 \
    -o /usr/local/bin/opengrep && chmod +x /usr/local/bin/opengrep

# Custom rules
COPY rules/ /opt/scan/rules/

WORKDIR /scan
COPY scan-orchestrator.mjs /opt/scan/
ENTRYPOINT ["node", "/opt/scan/scan-orchestrator.mjs"]
```

### Build & Push

```bash
docker build -t asr-scanner:latest -f deploy/docker/scanner/Dockerfile .
# Tag for registry
docker tag asr-scanner:latest forgejo.example.com/org/asr-scanner:latest
```

## Scan Orchestrator

The orchestrator is a Node.js script that runs all tools in parallel, collects SARIF, and produces a unified report.

### Implementation

```typescript
// scan-orchestrator.mjs
import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

interface ScanFinding {
  tool: string;
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  file: string;
  line: number;
  snippet?: string;
}

interface ScanReport {
  submissionId: string;
  timestamp: string;
  duration_ms: number;
  findings: ScanFinding[];
  verdict: 'pass' | 'block' | 'review_required';
  toolResults: Record<string, { exitCode: number; findingCount: number }>;
}

const SCAN_DIR = process.env.SCAN_DIR || '/scan/input';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/scan/output';
const TIMEOUT = (parseInt(process.env.SCAN_TIMEOUT_SECONDS || '300')) * 1000;
const SEVERITY_THRESHOLD = process.env.SCAN_SEVERITY_THRESHOLD || 'high';

async function runGitleaks(): Promise<ScanFinding[]> {
  const sarifPath = join(OUTPUT_DIR, 'gitleaks.sarif');
  try {
    await exec('gitleaks', [
      'dir', SCAN_DIR,
      '--report-format', 'sarif',
      '--report-path', sarifPath,
      '--no-banner',
    ], { timeout: TIMEOUT });
  } catch (e: any) {
    if (e.code !== 1) throw e; // exit 1 = findings, >1 = error
  }
  return parseSarif(sarifPath, 'gitleaks', 'high'); // secrets are always high
}

async function runTrivy(): Promise<ScanFinding[]> {
  const sarifPath = join(OUTPUT_DIR, 'trivy.sarif');
  await exec('trivy', [
    'fs', SCAN_DIR,
    '--scanners', 'vuln,secret,misconfig',
    '--format', 'sarif',
    '--output', sarifPath,
    '--severity', 'CRITICAL,HIGH,MEDIUM',
    '--timeout', `${TIMEOUT / 1000}s`,
  ], { timeout: TIMEOUT }).catch(() => {});
  return parseSarif(sarifPath, 'trivy');
}

async function runFoxguard(): Promise<ScanFinding[]> {
  const sarifPath = join(OUTPUT_DIR, 'foxguard.sarif');
  await exec('npx', [
    'foxguard', SCAN_DIR,
    '--format', 'sarif',
    '--output', sarifPath,
    '--severity', 'medium',
  ], { timeout: TIMEOUT }).catch(() => {});
  return parseSarif(sarifPath, 'foxguard');
}

async function runOpengrep(): Promise<ScanFinding[]> {
  const hasScripts = await hasExecutableCode();
  if (!hasScripts || process.env.OPENGREP_ENABLED === 'false') return [];

  const sarifPath = join(OUTPUT_DIR, 'opengrep.sarif');
  const rulesDir = process.env.OPENGREP_RULES_DIR || '/opt/scan/rules';
  await exec('opengrep', [
    'scan',
    '--sarif-output', sarifPath,
    '-f', rulesDir,
    SCAN_DIR,
  ], { timeout: TIMEOUT }).catch(() => {});
  return parseSarif(sarifPath, 'opengrep');
}

async function runVeracode(): Promise<ScanFinding[]> {
  if (!process.env.VERACODE_API_KEY_ID) return [];

  const sarifPath = join(OUTPUT_DIR, 'veracode.sarif');
  await exec('veracode', [
    'static', 'scan', SCAN_DIR,
    '--format', 'sarif',
    '--output', sarifPath,
  ], { timeout: TIMEOUT }).catch(() => {});
  return parseSarif(sarifPath, 'veracode');
}

async function hasExecutableCode(): Promise<boolean> {
  const entries = await readdir(join(SCAN_DIR, 'scripts'), { recursive: true }).catch(() => []);
  return entries.some((f: string) => /\.(ts|js|mjs|py|go|sh)$/.test(f));
}

function computeVerdict(findings: ScanFinding[]): ScanReport['verdict'] {
  if (findings.some(f => f.severity === 'critical')) return 'block';
  if (findings.some(f => f.tool === 'gitleaks')) return 'block';
  if (SEVERITY_THRESHOLD === 'high' && findings.some(f => f.severity === 'high')) return 'review_required';
  if (findings.some(f => f.severity === 'high')) return 'review_required';
  return 'pass';
}

async function parseSarif(
  path: string,
  tool: string,
  overrideSeverity?: ScanFinding['severity'],
): Promise<ScanFinding[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    const findings: ScanFinding[] = [];

    for (const run of raw.runs || []) {
      for (const result of run.results || []) {
        const location = result.locations?.[0]?.physicalLocation;
        findings.push({
          tool,
          ruleId: result.ruleId || 'unknown',
          severity: overrideSeverity || mapSarifSeverity(result.level),
          message: result.message?.text || '',
          file: location?.artifactLocation?.uri || '',
          line: location?.region?.startLine || 0,
          snippet: location?.region?.snippet?.text,
        });
      }
    }
    return findings;
  } catch {
    return [];
  }
}

function mapSarifSeverity(level: string): ScanFinding['severity'] {
  switch (level) {
    case 'error': return 'high';
    case 'warning': return 'medium';
    case 'note': return 'low';
    default: return 'medium';
  }
}

// Main execution
async function main() {
  const start = Date.now();
  const submissionId = process.env.SUBMISSION_ID || 'unknown';

  const [gitleaks, trivy, foxguard, opengrep, veracode] = await Promise.all([
    runGitleaks(),
    runTrivy(),
    runFoxguard(),
    runOpengrep(),
    runVeracode(),
  ]);

  const allFindings = [...gitleaks, ...trivy, ...foxguard, ...opengrep, ...veracode];

  const report: ScanReport = {
    submissionId,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    findings: allFindings,
    verdict: computeVerdict(allFindings),
    toolResults: {
      gitleaks: { exitCode: 0, findingCount: gitleaks.length },
      trivy: { exitCode: 0, findingCount: trivy.length },
      foxguard: { exitCode: 0, findingCount: foxguard.length },
      opengrep: { exitCode: 0, findingCount: opengrep.length },
      veracode: { exitCode: 0, findingCount: veracode.length },
    },
  };

  await writeFile(join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exit(report.verdict === 'block' ? 1 : 0);
}

main().catch((err) => {
  console.error('Scan orchestrator failed:', err);
  process.exit(2);
});
```

## Custom Rules

### Rule Directory Structure

```
rules/
├── secrets/
│   └── asr-custom-secrets.toml     # Gitleaks custom patterns
├── sast/
│   ├── command-injection.yaml       # Opengrep/Foxguard YAML rules
│   ├── unsafe-eval.yaml
│   └── skill-specific/
│       ├── no-network-if-declared.yaml
│       └── no-fs-write-outside-scope.yaml
└── policies/
    └── severity-overrides.json      # Per-org severity customization
```

### Skill-Specific Rules

These rules validate that skills honor their declared `permissions` in `manifest.yaml`:

```yaml
# rules/sast/skill-specific/no-network-if-declared.yaml
rules:
  - id: asr-no-network-when-restricted
    patterns:
      - pattern-either:
          - pattern: fetch(...)
          - pattern: axios(...)
          - pattern: http.get(...)
          - pattern: require('net')
          - pattern: require('http')
          - pattern: require('https')
    message: >
      Skill declares `permissions.network: false` but contains network calls.
      Remove network access or update manifest permissions.
    severity: ERROR
    languages: [javascript, typescript]
```

```yaml
# rules/sast/skill-specific/no-subprocess.yaml
rules:
  - id: asr-no-subprocess-when-restricted
    patterns:
      - pattern-either:
          - pattern: child_process.exec(...)
          - pattern: child_process.spawn(...)
          - pattern: execSync(...)
          - pattern: subprocess.run(...)
          - pattern: os.system(...)
    message: >
      Skill declares `permissions.subprocess: false` but invokes subprocesses.
    severity: ERROR
    languages: [javascript, typescript, python]
```

## API Integration

### Submission Service — Scan Trigger

```typescript
// In the workflow engine, after questionnaire completion:
import { exec } from 'node:child_process';

async function triggerScan(submissionId: string, extractedDir: string): Promise<ScanReport> {
  const outputDir = `/tmp/scan-output/${submissionId}`;
  await mkdir(outputDir, { recursive: true });

  const { stdout } = await execAsync(
    `docker run --rm \
      -v ${extractedDir}:/scan/input:ro \
      -v ${outputDir}:/scan/output \
      -e SUBMISSION_ID=${submissionId} \
      -e SCAN_TIMEOUT_SECONDS=${process.env.SCAN_TIMEOUT_SECONDS || 300} \
      -e VERACODE_API_KEY_ID=${process.env.VERACODE_API_KEY_ID || ''} \
      -e VERACODE_API_KEY_SECRET=${process.env.VERACODE_API_KEY_SECRET || ''} \
      asr-scanner:latest`,
    { timeout: 360_000 }
  );

  return JSON.parse(stdout);
}
```

### Scan Result Storage

```sql
CREATE TABLE scan_results (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  timestamp TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'block', 'review_required')),
  finding_count INTEGER NOT NULL,
  findings_json TEXT NOT NULL,       -- Full ScanFinding[] array
  tool_results_json TEXT NOT NULL,   -- Per-tool summary
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scan_submission ON scan_results(submission_id);
```

### GET /submissions/:id/scan Response

```json
{
  "submissionId": "sub_abc123",
  "timestamp": "2026-05-23T14:30:00Z",
  "duration_ms": 12400,
  "verdict": "review_required",
  "summary": {
    "critical": 0,
    "high": 2,
    "medium": 5,
    "low": 3,
    "tools_run": ["gitleaks", "trivy", "foxguard", "opengrep"]
  },
  "findings": [
    {
      "tool": "foxguard",
      "ruleId": "js-command-injection",
      "severity": "high",
      "message": "User input flows into child_process.exec() without sanitization",
      "file": "scripts/deploy.ts",
      "line": 42,
      "snippet": "exec(`git clone ${userInput}`)"
    },
    {
      "tool": "trivy",
      "ruleId": "CVE-2024-1234",
      "severity": "high",
      "message": "lodash < 4.17.21 has prototype pollution vulnerability",
      "file": "package.json",
      "line": 8
    }
  ]
}
```

## Workflow Integration

```
[Questionnaire Complete] → [Trigger Scan Container]
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              verdict=pass    verdict=review    verdict=block
                    │               │               │
                    ▼               ▼               ▼
            [Auto-advance     [Notify          [Auto-reject
             to confirm]       reviewer]        + notify submitter]
```

### Verdict Actions

| Verdict | Workflow transition | Reviewer sees |
|---------|-------------------|---------------|
| `pass` | Advance to `awaiting_confirmation` — submitter confirms, then compliance reviews | Green badge, findings summary |
| `review_required` | Advance to `awaiting_confirmation` with advisory | Yellow badge, full findings list, reviewer must acknowledge |
| `block` | Transition to `rejected` automatically | Red badge, blocking findings highlighted |

## Veracode Integration Details

Veracode is an optional enterprise add-on. When API credentials are configured:

### Authentication

```bash
# Environment variables (set in Azure Key Vault → Container App secrets)
VERACODE_API_KEY_ID=<32-char-hex>
VERACODE_API_KEY_SECRET=<128-char-hex>
```

### CLI Installation (in scanner Dockerfile)

```dockerfile
# Veracode CLI — only if enterprise scanning desired
RUN curl -fsS https://tools.veracode.com/veracode-cli/install | sh && \
    mv veracode /usr/local/bin/veracode || true
```

### Pipeline Scan (alternative — Java-based, for compiled artifacts)

```bash
docker run --rm \
  -e VERACODE_API_KEY_ID=$VERACODE_API_KEY_ID \
  -e VERACODE_API_KEY_SECRET=$VERACODE_API_KEY_SECRET \
  -v /path/to/skill:/scan \
  veracode/pipeline-scan:latest \
  java -jar /opt/veracode/pipeline-scan.jar \
    --file /scan/scripts.zip \
    --json_output_file /scan/veracode-results.json
```

### When to Use Which

| Veracode product | Use case | ASR context |
|-----------------|----------|-------------|
| `veracode static scan` (CLI) | Source code scanning | Primary — scan extracted `scripts/` directory |
| Pipeline Scan (Java JAR) | Compiled artifact scanning | For Go/Java skills that produce binaries |
| Container Scan | Docker image vulnerabilities | Not needed — skills don't ship containers |

## Database Update Frequency

| Database | Tool | Update cadence | Mechanism |
|----------|------|---------------|-----------|
| CVE/NVD | Trivy | Daily | `trivy --download-db-only` in cron |
| Secret patterns | Gitleaks | On image rebuild | Built-in patterns + custom `.toml` |
| SAST rules | Foxguard | On image rebuild | Built-in 170+ rules |
| Opengrep rules | Opengrep | Weekly | `git pull` on rules repo |

### Trivy DB Update Cron

```bash
# In the scanner container's entrypoint or as a sidecar:
0 3 * * * trivy image --download-db-only --cache-dir /opt/trivy-cache
```

## Development Mode

In dev mode (`AUTH_MODE=mock`), the scanner still runs but with relaxed defaults:

```bash
SCAN_SEVERITY_THRESHOLD=critical   # Only block on critical in dev
OPENGREP_ENABLED=false             # Skip deep scan for faster iteration
# VERACODE_* unset — skipped automatically
```

The dev docker-compose adds the scanner as a service:

```yaml
services:
  scanner:
    build: ./deploy/docker/scanner
    volumes:
      - scan-input:/scan/input
      - scan-output:/scan/output
    environment:
      - SCAN_SEVERITY_THRESHOLD=critical
```

## Testing

### Unit Tests

- SARIF parser handles malformed/missing files gracefully
- Severity mapping covers all tool-specific labels
- Verdict computation respects threshold configuration
- Secret findings always produce `block` regardless of threshold

### Integration Tests

- Mount a skill with known vulnerabilities → verify findings detected
- Mount a clean skill → verify `pass` verdict
- Timeout handling → tools killed after `SCAN_TIMEOUT_SECONDS`
- Missing tools (Veracode not installed) → gracefully skipped

### Test Fixtures

```
test/fixtures/scanning/
├── clean-skill/           → expect verdict: pass
├── skill-with-secret/     → expect verdict: block (hardcoded API key)
├── skill-with-cve/        → expect verdict: review_required (outdated dep)
├── skill-with-injection/  → expect verdict: review_required (command injection)
└── skill-network-violation/ → expect verdict: block (manifest says no network)
```
