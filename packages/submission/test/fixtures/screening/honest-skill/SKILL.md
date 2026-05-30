---
name: screening-honest
version: 1.0.0
author: ASR Tests
description: Formats local text provided by the user without network access.
tags:
  - fixture
kind: skill
entrypoint: scripts/format.ts
permissions:
  network: false
  filesystem: read-own
  subprocess: false
  environment: []
compatibility:
  codex: ">=0.1.0"
---

# screening-honest

Use this skill to normalize whitespace in local text snippets. It does not call external
services, spawn subprocesses, or read secrets from the environment.
