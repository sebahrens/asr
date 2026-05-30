# ASR Scanner Image

This image runs the ASR security scan tools in a dedicated container. It follows
the pre-flight requirement in `specs/security-scanning.md`: production scanner
images must use resolved version pins and must not use `:latest` tags or
`/latest/` release URLs.

## Pinned tools

| Tool | Pin | Distribution | Resolved digest / integrity |
| --- | --- | --- | --- |
| Gitleaks | `v8.30.1` | `zricethezav/gitleaks:v8.30.1`, binary copied from `/usr/bin/gitleaks` | `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` (image index) |
| Trivy | `v0.70.0` | Installer fetched from `aquasecurity/trivy` raw tag `v0.70.0` (`contrib/install.sh`), then `trivy image --download-db-only` | Tag-pinned source URL; verify via `trivy_0.70.0_checksums.txt` from the release |
| Foxguard | `0.8.1` | npm package `foxguard@0.8.1`, which exposes the `foxguard` bin | `sha512-RGk/S/0fFSaPvft41ZMHjTMoblFjdDuUTITcE2NfT7yKPp8giN4ICk1l4e9M6kPC/yDGVB/pvIZzrFDdCM2JvA==` (npm tarball integrity) |
| Opengrep | `v1.22.0` | GitHub release asset `opengrep_manylinux_x86` or `opengrep_manylinux_aarch64`, selected from Docker `TARGETARCH` | `sha256:45bcd58440e397ed52c50e953ccf5948909ea77087c9186fc7d277216f62e319` (x86), `sha256:8df71670e20336646687c6f4ddf9b4532f1a7fcd8a8ea7bfa4ea46747f61e088` (aarch64) |
| Veracode | `2.27.0` | Installer from `tools.veracode.com/veracode-cli/install` with `VERSION=2.27.0` (Tier 3, optional). Layer is build-safe (`\|\| true`); the orchestrator only invokes `veracode` when `VERACODE_API_KEY_ID`/`VERACODE_API_KEY_SECRET` are set, so a missing binary is a clean skip. | Upstream installer does not publish a per-version artifact digest; the `VERSION` env pins the resolver output. |

Every pin is parameterised by a Dockerfile `ARG` so future bumps are explicit
and auditable. `grep -REn ':latest|@latest|releases/latest'
deploy/docker/scanner/Dockerfile` must return no matches.

## Opengrep rules

The scanner image copies `deploy/docker/scanner/rules/` to `/opt/scan/rules/`,
which is the default `OPENGREP_RULES_DIR`. The checked-in ruleset currently
contains ASR-authored Opengrep-compatible rules for:

- Python subprocess calls with `shell=True`, `os.system`, dynamic code
  execution, dynamic imports, and raw sockets
- JavaScript/TypeScript shell-backed child process APIs, dynamic code execution,
  dynamic imports, and raw network modules
- Generic bearer-token egress, embedded API keys, and `LD_PRELOAD`
  runtime-linker manipulation

Rule provenance and import policy are documented in
`deploy/docker/scanner/rules/README.md`. The short version: ASR-authored rules
are project-owned; future community-rule imports must come from
`opengrep/opengrep-rules` with source path, commit, and LGPL-2.1 provenance
recorded. Do not vendor rules from `semgrep/semgrep-rules`.

## Trivy policy

Trivy is configured by `trivy.yaml` and `.trivyignore`, both copied into the
image under `/opt/scan/`. ASR uses Trivy for dependency CVEs and IaC
misconfiguration findings only; secret scanning is intentionally left to
Gitleaks so the unified SARIF report does not double-report the same credential.

The orchestrator passes `--config /opt/scan/trivy.yaml` and
`--ignorefile /opt/scan/.trivyignore` on every filesystem scan. Runtime severity
filtering follows `SCAN_SEVERITY_THRESHOLD`: `critical` scans only critical
findings, `high` scans critical/high, `medium` scans critical/high/medium, and
`low` includes low findings as well. `.trivyignore` is currently empty except
for comments; accepted suppressions must be narrow CVE or misconfiguration IDs
with reviewer-approved expiry context in the associated bead or commit.

The Dockerfile preloads Trivy vulnerability databases at build time for faster
first scans, but production freshness depends on image rebuild cadence. Rebuild
and redeploy the scanner image daily, or before each release train, so
`trivy image --download-db-only` refreshes both the vulnerability DB and Java DB
from the configured mirror-first repositories. Runtime scans leave
`db.skip-update` disabled as a fallback, allowing Trivy to refresh stale DBs if
egress is available.

## Foxguard policy

Foxguard runs its built-in 170+ rule pack by default. ASR keeps built-ins
enabled and can add organization-owned Semgrep/OpenGrep-compatible rules by
setting `FOXGUARD_RULES` to a rule file or directory; the orchestrator does not
pass `--no-builtins`. The default threshold is
`FOXGUARD_SEVERITY_THRESHOLD=medium` with `FOXGUARD_MIN_CONFIDENCE=0.5`, which
keeps low-signal findings out of the review queue while preserving medium,
high, and critical SAST results.

The pinned `foxguard@0.8.1` CLI emits SARIF to stdout, so the orchestrator
captures stdout into `foxguard.sarif` instead of passing an unsupported
`--output` flag. Its supported languages cover the executable skill code ASR
sees most often: Python, JavaScript, and TypeScript. Shell scripts are not a
Foxguard-supported language in this release; ASR covers shell-specific risks
with the ASR-authored Opengrep rules plus Gitleaks and Trivy.

Foxguard SARIF commonly reports numeric `security-severity` metadata such as
`8.0` instead of literal labels. The orchestrator maps numeric values using the
standard SARIF convention: `>=9` critical, `>=7` high, `>=4` medium, and `>0`
low, falling back to SARIF `level` when metadata is absent.

## Build check

```bash
docker build -t asr-scanner:test -f deploy/docker/scanner/Dockerfile deploy/docker/scanner
docker run --rm --entrypoint sh asr-scanner:test -c 'command -v gitleaks && command -v trivy && command -v opengrep && command -v foxguard'
# Veracode is optional; presence depends on tools.veracode.com reachability at build time.
docker run --rm --entrypoint sh asr-scanner:test -c 'command -v veracode || echo "veracode not installed (Tier 3 optional)"'
```
