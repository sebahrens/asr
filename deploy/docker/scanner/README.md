# ASR Scanner Image

This image runs the ASR security scan tools in a dedicated container. It follows
the pre-flight requirement in `specs/security-scanning.md`: production scanner
images must use resolved version pins and must not use `:latest` tags or
`/latest/` release URLs.

## Pinned tools

| Tool | Pin | Distribution | Resolved digest / integrity |
| --- | --- | --- | --- |
| Gitleaks | `v8.30.1` | `zricethezav/gitleaks:v8.30.1`, binary copied from `/usr/bin/gitleaks` | `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` (image index) |
| Node | `22-slim` | `node:22-slim` base image | `sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732` (image index) |
| Trivy | `v0.70.0` | Release tarball `trivy_0.70.0_Linux-{64bit,ARM64}.tar.gz`, selected from Docker `TARGETARCH` | `sha256:8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9` (amd64), `sha256:2f6bb988b553a1bbac6bdd1ce890f5e412439564e17522b88a4541b4f364fc8d` (arm64) |
| Foxguard | `0.8.1` | npm wrapper tarball plus native release asset `foxguard-linux-{x86_64,aarch64}`, selected from Docker `TARGETARCH` | wrapper `sha512:44693f4bfd1f15268fbdfb78d593078d33286e5163743b944c84dc13635f4fbc8a3e9f2088de080a4d65e1ef4cea43c2ff20c6541fe9bc8673ac50dd08cd89bc`; native `sha256:ad49914507d390888d4ae481dd7de2a0374e2a03fe1558603edc408daf303851` (amd64), `sha256:a4e8faabdb814eb2eddf77c7c4b2dc5a36ce0fb7c463fa359e562bc2f2386e22` (arm64) |
| Opengrep | `v1.22.0` | Release asset `opengrep_manylinux_x86` or `opengrep_manylinux_aarch64`, selected from Docker `TARGETARCH` | `sha256:45bcd58440e397ed52c50e953ccf5948909ea77087c9186fc7d277216f62e319` (x86), `sha256:8df71670e20336646687c6f4ddf9b4532f1a7fcd8a8ea7bfa4ea46747f61e088` (aarch64) |
| Veracode | `2.49.0` | Not installed by default (Tier 3, optional). The orchestrator only invokes `veracode` when `VERACODE_API_KEY_ID`/`VERACODE_API_KEY_SECRET` are set, so a missing binary is a clean skip. | Upstream installer does not publish a per-version artifact digest; `INSTALL_VERACODE_CLI=true` fails closed until a verifiable artifact is available. |

Every pin is parameterised by a Dockerfile `ARG` so future bumps are explicit
and auditable. `grep -REn ':latest|@latest|releases/latest'
deploy/docker/scanner/Dockerfile` must return no matches.
The scanner Dockerfile also must not pipe downloaded scripts into a shell.

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

## Exit code policy

The scanner report preserves raw tool exit codes in `toolResults`, but verdicts
are based on validated findings plus a small allowlist of scanner-specific
nonzero exits. `@asr/core` and the container orchestrator must stay aligned:

- `0` is success for every tool.
- Gitleaks `1` is expected only when SARIF findings were parsed; those findings
  still hard-block because secrets always block.
- Foxguard `2` is expected for skipped files when finding counts remain
  consistent.
- Optional tools marked `skipped: true` do not fail the verdict.
- Missing tool results, mismatched finding counts, and all other nonzero exits
  are treated as scanner failures and force a `block` verdict.

## Veracode policy

Veracode is Tier 3 and remains a clean skip unless both
`VERACODE_API_KEY_ID` and `VERACODE_API_KEY_SECRET` are present. Production
Container Apps read those values, plus `VERACODE_POLICY`, from Azure Key Vault
and pass them through to the scanner container at runtime.

The pinned CLI uses the documented `veracode scan --type directory --source
/scan/input --format json --output /scan/output/veracode.json --policy
<policy>` form. Veracode CLI `2.49.0` does not advertise SARIF output for this
command, so the orchestrator parses the JSON output directly and normalizes
Veracode severities into ASR severities. `Very High` maps to `critical`.

## Build check

```bash
docker build -t asr-scanner:test -f deploy/docker/scanner/Dockerfile deploy/docker/scanner
docker run --rm --entrypoint sh asr-scanner:test -c 'command -v gitleaks && command -v trivy && command -v opengrep && command -v foxguard'
# Veracode is optional and omitted by default because upstream does not publish
# a per-version artifact digest for the installer.
docker run --rm --entrypoint sh asr-scanner:test -c 'command -v veracode || echo "veracode not installed (Tier 3 optional)"'
```
