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

## Build check

```bash
docker build -t asr-scanner:test -f deploy/docker/scanner/Dockerfile deploy/docker/scanner
docker run --rm --entrypoint sh asr-scanner:test -c 'command -v gitleaks && command -v trivy && command -v opengrep && command -v foxguard'
# Veracode is optional; presence depends on tools.veracode.com reachability at build time.
docker run --rm --entrypoint sh asr-scanner:test -c 'command -v veracode || echo "veracode not installed (Tier 3 optional)"'
```
