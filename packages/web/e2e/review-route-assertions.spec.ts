import type { Route } from 'playwright/test';
import { expect, test } from 'playwright/test';

// Regression assertions filed under asr-tpwa.
//
// Background: between 2026-05-27 and 2026-05-31, ~30 visual-review sessions
// claimed the web UI was "production-ready, zero defects" while /review
// shipped with no stylesheet (asr-xu7u) and /review/:id was inaccessible in
// dev mode (asr-pjuo). The reviews all exempted /review as "under development
// per asr-0mf.4-5" — an exemption that stuck in agent memory and was
// re-applied every run after asr-0mf.4 actually merged on 2026-05-27.
//
// These tests force the visual-review suite to look at /review every time.
// Do not delete them, and do not mark them skip/fixme without first reading
// the asr-tpwa description.

function jsonResponse(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test.describe('/review queue is styled and renders rows for Compliance', () => {
  test('table.review-queue-table has non-default border-collapse + padding and at least one row', async ({ page }) => {
    await page.route('**/api/v1/submissions?*', (route) =>
      jsonResponse(route, {
        submissions: [
          { id: 'sub-asr-tpwa-1', skillName: 'asr-tpwa-fixture', version: '1.0.0' },
          { id: 'sub-asr-tpwa-2', skillName: 'asr-tpwa-second', version: '0.2.1' },
        ],
      }),
    );

    await page.goto('/review');

    await expect(page.getByRole('heading', { name: /review queue/i })).toBeVisible();

    const table = page.locator('table.review-queue-table');
    await expect(table).toBeVisible();

    // Catches missing-stylesheet regressions (asr-xu7u): the UA defaults are
    // border-collapse:collapse and 0 padding on <td>. The styled queue sets
    // border-collapse:separate and 16px 24px padding on tbody cells.
    const computed = await table.evaluate((el) => {
      const tableStyle = window.getComputedStyle(el);
      const cell = el.querySelector('tbody td');
      const cellStyle = cell ? window.getComputedStyle(cell) : null;
      return {
        borderCollapse: tableStyle.borderCollapse,
        borderRadius: tableStyle.borderRadius,
        cellPaddingTop: cellStyle?.paddingTop ?? null,
        cellPaddingLeft: cellStyle?.paddingLeft ?? null,
      };
    });
    expect(computed.borderCollapse).toBe('separate');
    expect(computed.borderRadius).not.toBe('0px');
    expect(computed.cellPaddingTop).not.toBe('0px');
    expect(computed.cellPaddingLeft).not.toBe('0px');

    const rows = page.locator('table.review-queue-table tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);

    await page.screenshot({
      path: 'test-results/asr-tpwa-review-queue.png',
      fullPage: true,
    });
  });
});

test.describe('/review/:id renders the canonical mock submission in dev mode', () => {
  test('sub-1042 lands on the diff tab, not the error state', async ({ page }) => {
    // Intentionally no page.route() mocks — this asserts the contract that
    // visiting /review/sub-1042 in a bare dev environment (vite, no api on
    // :3001) renders the diff tab. The fix for asr-pjuo must route
    // ReviewDetail through the in-app mocks (App.tsx) or add the missing
    // /api/v1/submissions/sub-1042{,/diff,/scan} handlers to dev-api.mjs.
    //
    // If this test starts failing, do NOT mark it skipped/fixme. The
    // failure means the canonical demo submission is broken in dev — fix
    // ReviewDetail data wiring instead.

    await page.goto('/review/sub-1042');

    // Wait for the page to leave the loading state — either the diff tab
    // panel or the error alert must eventually render.
    await page.waitForSelector(
      '[role="tabpanel"], [role="alert"]',
      { timeout: 15_000 },
    );

    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /diff/i })).toBeVisible();
    await expect(
      page.getByRole('tabpanel', { name: /diff/i }),
    ).toBeVisible();

    await page.screenshot({
      path: 'test-results/asr-tpwa-review-detail.png',
      fullPage: true,
    });
  });

  test('mobile evidence panels wrap diff and scan content without clipping', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/review/sub-1042');

    await expect(page.getByRole('tabpanel', { name: /diff/i })).toBeVisible();

    const diffMetrics = await page.locator(
      '.review-diff-viewer, .review-diff-viewer table, .review-diff-viewer [class*="content-text"]',
    ).evaluateAll((elements) =>
      elements.map((element) => ({
        className: String(element.className),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        text: element.textContent?.slice(0, 120) ?? '',
      })),
    );

    expect(diffMetrics.length).toBeGreaterThan(0);
    for (const metric of diffMetrics) {
      expect(
        metric.scrollWidth,
        `${metric.className} clips "${metric.text}"`,
      ).toBeLessThanOrEqual(metric.clientWidth + 1);
    }

    await page.getByRole('tab', { name: /^scan$/i }).click();
    await expect(page.getByRole('tabpanel', { name: /scan/i })).toBeVisible();

    const scanMetrics = await page.locator('.review-detail-scan-findings summary').evaluateAll((summaries) =>
      summaries.map((summary) => {
        const children = Array.from(summary.children).map((child) => {
          const rect = child.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            clientWidth: child.clientWidth,
            scrollWidth: child.scrollWidth,
            top: rect.top,
            text: child.textContent ?? '',
          };
        });
        return {
          children,
          summaryClientWidth: summary.clientWidth,
          summaryScrollWidth: summary.scrollWidth,
        };
      }),
    );

    expect(scanMetrics.length).toBeGreaterThan(0);
    for (const metric of scanMetrics) {
      expect(metric.summaryScrollWidth).toBeLessThanOrEqual(metric.summaryClientWidth + 1);
      for (const child of metric.children) {
        expect(child.scrollWidth, `scan summary clips "${child.text}"`).toBeLessThanOrEqual(child.clientWidth + 1);
      }
      for (let index = 1; index < metric.children.length; index += 1) {
        expect(metric.children[index].top).toBeGreaterThanOrEqual(metric.children[index - 1].bottom);
      }
    }
  });
});
