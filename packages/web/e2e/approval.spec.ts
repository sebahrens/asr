import type { Route } from 'playwright/test';
import { expect, test } from 'playwright/test';

const REVIEWER_SUB = 'dev-compliance';
const OTHER_SUBMITTER_SUB = 'submitter-other';

interface PendingRow {
  id: string;
  skillName: string;
  version: string;
}

interface PendingResponse {
  submissions: PendingRow[];
}

function jsonResponse(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function buildSubmission(submittedBy: string) {
  return {
    id: 'sub-e2e-1',
    manifest: {
      name: 'approval-spec-skill',
      version: '0.1.0',
      author: submittedBy,
      description: 'Submission used by approval.spec.ts',
      tags: [],
      kind: 'skill',
      permissions: {
        network: false,
        filesystem: 'none',
        subprocess: false,
        environment: [],
      },
    },
    classification: 'md-only',
    contentHash: 'sha256:e2e-approval-spec',
    submittedAt: '2026-05-27T00:00:00.000Z',
    submittedBy,
    status: { phase: 'compliance-review' },
  };
}

const versionDiff = {
  skillName: 'approval-spec-skill',
  fromVersion: '',
  toVersion: '0.1.0',
  fromContentHash: null,
  toContentHash: 'sha256:e2e-approval-spec',
  filesAdded: ['SKILL.md'],
  filesRemoved: [],
  filesModified: [],
  dependenciesAdded: {},
  dependenciesRemoved: {},
  dependenciesChanged: {},
  permissionsBefore: null,
  permissionsAfter: {
    network: false,
    filesystem: 'none',
    subprocess: false,
    environment: [],
  },
  permissionsExpanded: false,
  manifestKindChanged: false,
  riskAssessment: 'low',
  computedAt: '2026-05-27T00:00:00.000Z',
};

const scanReport = {
  submissionId: 'sub-e2e-1',
  scanId: 'scan-e2e-1',
  contentHash: 'sha256:e2e-approval-spec',
  scannerImage: 'asr-scanner:dev',
  startedAt: '2026-05-27T00:00:00.000Z',
  completedAt: '2026-05-27T00:00:05.000Z',
  durationMs: 5000,
  verdict: 'pass',
  findings: [],
  toolResults: {},
};

test.describe('Approval decision SoD and queue removal', () => {
  test('disables Approve and Reject when submitter sub equals reviewer sub', async ({ page }) => {
    const submission = buildSubmission(REVIEWER_SUB);
    const pending: PendingResponse = {
      submissions: [
        { id: submission.id, skillName: submission.manifest.name, version: submission.manifest.version },
      ],
    };

    await page.route('**/api/v1/submissions?*', (route) => jsonResponse(route, pending));
    await page.route('**/api/v1/submissions/sub-e2e-1', (route) => jsonResponse(route, submission));
    await page.route('**/api/v1/submissions/sub-e2e-1/diff', (route) => jsonResponse(route, versionDiff));
    await page.route('**/api/v1/submissions/sub-e2e-1/scan', (route) => jsonResponse(route, scanReport));

    await page.goto('/review/sub-e2e-1');

    await expect(page.getByRole('heading', { name: submission.manifest.name })).toBeVisible();
    await expect(page.getByText(/separation of duties/i)).toBeVisible();

    await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });

  test('removes an approved submission from the /review queue', async ({ page }) => {
    const submission = buildSubmission(OTHER_SUBMITTER_SUB);
    let approveCalled = false;

    await page.route('**/api/v1/submissions?*', (route) => {
      const submissions: PendingRow[] = approveCalled
        ? []
        : [{ id: submission.id, skillName: submission.manifest.name, version: submission.manifest.version }];
      return jsonResponse(route, { submissions } satisfies PendingResponse);
    });
    await page.route('**/api/v1/submissions/sub-e2e-1', (route) => jsonResponse(route, submission));
    await page.route('**/api/v1/submissions/sub-e2e-1/diff', (route) => jsonResponse(route, versionDiff));
    await page.route('**/api/v1/submissions/sub-e2e-1/scan', (route) => jsonResponse(route, scanReport));
    await page.route('**/api/v1/submissions/sub-e2e-1/approve', (route) => {
      approveCalled = true;
      return jsonResponse(route, { ok: true });
    });

    await page.goto('/review');

    const queueLink = page.getByRole('link', { name: submission.manifest.name });
    await expect(queueLink).toBeVisible();
    await queueLink.click();

    await expect(page).toHaveURL(/\/review\/sub-e2e-1$/);

    const approveButton = page.getByRole('button', { name: 'Approve' });
    await expect(approveButton).toBeEnabled();
    await approveButton.click();

    const confirmDialog = page.getByRole('dialog', { name: /confirm approve/i });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Confirm approve' }).click();

    await expect.poll(() => approveCalled).toBe(true);
    await expect(confirmDialog).toBeHidden();

    await page.goto('/review');

    await expect(page.getByText(/no submissions awaiting review/i)).toBeVisible();
    await expect(page.getByRole('link', { name: submission.manifest.name })).toHaveCount(0);
  });
});
