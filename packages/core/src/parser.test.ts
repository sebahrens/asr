import { describe, expect, it } from 'vitest';

import { parseSkillManifest } from './parser.js';

describe('parseSkillManifest', () => {
  it('returns a validated manifest and trimmed markdown body', () => {
    const skillMd = `---
name: security-reviewer
version: 1.0.0
author: ASR Team
description: Reviews submissions for security risks.
tags:
  - security
  - review
permissions:
  network: false
  filesystem: read-own
  subprocess: false
  environment: []
---

# Security Reviewer

Review submissions before approval.
`;

    const { manifest, body } = parseSkillManifest(skillMd);

    expect(manifest.name).toBe('security-reviewer');
    expect(manifest.version).toBe('1.0.0');
    expect(body).toBe('# Security Reviewer\n\nReview submissions before approval.');
  });

  it('rejects content without YAML frontmatter', () => {
    expect(() => parseSkillManifest('# Security Reviewer')).toThrow(/missing YAML frontmatter/);
  });
});
