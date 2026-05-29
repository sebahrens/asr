# ASR Opengrep Rules

This directory contains the rules loaded by `OPENGREP_RULES_DIR` in the scanner
container. The current checked-in rules are ASR-authored Opengrep/Semgrep-format
YAML rules, so no third-party rule text is vendored here.

## Provenance and license

| Path | Provenance | License status |
| --- | --- | --- |
| `asr/*.yml` | Authored for ASR from the scanner threat model in `specs/security-scanning.md` and bead `asr-mnkz.1` | Project-owned ASR code |

Opengrep itself and the upstream `opengrep/opengrep-rules` repository are
LGPL-2.1. Future imports from `opengrep/opengrep-rules` are allowed only when
the source file path, upstream commit, and license are recorded in this table.
Do not import from `semgrep/semgrep-rules`; the scanner spec excludes that
repository because its rule license restricts SaaS use.

## Severity policy

The scanner orchestrator normalizes Opengrep SARIF as follows:

| Rule severity | `metadata.confidence` | ASR severity |
| --- | --- | --- |
| `ERROR` | `HIGH` | `critical` |
| `ERROR` | other | `high` |
| `WARNING` | any | `medium` |
| `INFO` | any | `low` |

Use `ERROR` plus `confidence: HIGH` only for rules specific enough to support
automatic blocking.
