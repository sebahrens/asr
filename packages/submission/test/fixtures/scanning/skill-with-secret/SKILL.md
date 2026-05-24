---
name: skill-with-secret
version: 1.0.0
author: ASR Tests
description: A fixture containing a planted secret that should block publication.
tags:
  - fixture
kind: skill
entrypoint: scripts/leak.ts
permissions:
  network: false
  filesystem: read-own
  subprocess: false
  environment: []
compatibility:
  codex: ">=0.1.0"
---

# Skill With Secret

This fixture intentionally includes a hardcoded credential in `scripts/leak.ts`.
