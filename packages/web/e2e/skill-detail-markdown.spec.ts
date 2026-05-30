import type { Route } from 'playwright/test';
import { expect, test } from 'playwright/test';

function jsonResponse(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

const skillDetail = {
  owner: 'asr',
  name: 'security-review',
  latestVersion: '1.0.0',
  description: 'Review code for security issues.',
  tags: ['security', 'review'],
  kind: 'skill',
  publishedAt: '2026-05-25T12:00:00.000Z',
  downloadCount: 42,
  riskAssessmentLatest: 'low',
  manifestLatest: {
    name: 'security-review',
    version: '1.0.0',
    author: 'Platform Team',
    description: 'Review code for security issues.',
    tags: ['security', 'review'],
    kind: 'skill',
    permissions: {
      network: false,
      filesystem: 'read-own',
      subprocess: false,
      environment: [],
    },
  },
  skillMd: `---
name: security-review
version: 1.0.0
author: Platform Team
description: Review code for security issues.
tags: [security, review]
---

# Secure Review

## Review Checklist

| Check | Evidence |
| --- | --- |
| Secrets | scanner output |
| Permissions | declared read scope |

## Example Finding

\`\`\`text
severity: high
file: SKILL.md
message: External exfiltration instruction detected
\`\`\`

## Links

- [ASR workflow](/review)
`,
  versions: [
    {
      owner: 'asr',
      name: 'security-review',
      version: '1.0.0',
      contentHash: 'sha256:abc',
      publishedAt: '2026-05-25T12:00:00.000Z',
      publishedBy: 'submitter',
      approvedBy: 'reviewer',
      prNumber: 12,
      mergeCommit: 'abc123',
      yanked: false,
      riskAssessment: 'low',
    },
  ],
};

test.describe('skill detail Markdown preview', () => {
  test('renders GFM tables with visible cell borders', async ({ page }) => {
    await page.route('**/api/v1/skills/asr/security-review', (route) => jsonResponse(route, skillDetail));

    await page.goto('/skills/asr/security-review');

    await expect(page.getByRole('heading', { name: /security-review/i })).toBeVisible();

    const table = page.locator('.skill-content table');
    await expect(table).toBeVisible();
    await expect(page.locator('.skill-content pre')).toBeVisible();
    await expect(page.getByRole('link', { name: /asr workflow/i })).toBeVisible();

    const computed = await table.evaluate((element) => {
      const tableStyle = window.getComputedStyle(element);
      const firstCell = element.querySelector('th, td');
      const cellStyle = firstCell ? window.getComputedStyle(firstCell) : null;
      return {
        borderCollapse: tableStyle.borderCollapse,
        tableBorderTopColor: tableStyle.borderTopColor,
        tableBorderTopWidth: tableStyle.borderTopWidth,
        cellBorderTopColor: cellStyle?.borderTopColor ?? null,
        cellBorderTopStyle: cellStyle?.borderTopStyle ?? null,
        cellBorderTopWidth: cellStyle?.borderTopWidth ?? null,
      };
    });

    expect(computed.borderCollapse).toBe('collapse');
    expect(computed.tableBorderTopWidth).toBe('1px');
    expect(computed.tableBorderTopColor).toBe('rgb(224, 224, 224)');
    expect(computed.cellBorderTopWidth).toBe('1px');
    expect(computed.cellBorderTopStyle).toBe('solid');
    expect(computed.cellBorderTopColor).toBe('rgb(224, 224, 224)');
  });
});
