# ASR Scanner Image

This image runs the ASR security scan tools in a dedicated container. It follows
the pre-flight requirement in `specs/security-scanning.md`: production scanner
images must use resolved version pins and must not use `:latest` tags or
`/latest/` release URLs.

## Pinned tools

| Tool | Pin | Distribution |
| --- | --- | --- |
| Gitleaks | `v8.30.1` | `zricethezav/gitleaks:v8.30.1`, binary copied from `/usr/bin/gitleaks` |
| Trivy | `v0.70.0` | Versioned installer from `aquasecurity/trivy` tag `v0.70.0`, then `trivy image --download-db-only` |
| Foxguard | `0.8.1` | npm package `foxguard@0.8.1`, which exposes the `foxguard` bin |
| Opengrep | `v1.22.0` | GitHub release assets `opengrep_manylinux_x86` or `opengrep_manylinux_aarch64`, selected from Docker `TARGETARCH` |

Veracode is intentionally not baked into this image. It is Tier 3 optional and
is configured separately when enterprise credentials are present.

## Build check

```bash
docker build -t asr-scanner:test -f deploy/docker/scanner/Dockerfile deploy/docker/scanner
docker run --rm --entrypoint sh asr-scanner:test -c 'command -v gitleaks && command -v trivy && command -v opengrep && command -v foxguard'
```
