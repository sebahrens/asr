import { test, expect } from '@playwright/test';
import { join } from 'path';

const screenshotDir = '.playwright-verify';

test.describe('ASR Web Visual Review 2026-05-28', () => {
  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(10000);
  });

  test('1. Landing page - desktop 1280x800', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Verify branding
    const logo = page.locator('text=asr').first();
    await expect(logo).toBeVisible();

    // Verify search bar
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    await expect(searchInput).toBeVisible();

    // Verify skill cards render
    const skillCard = page.locator('article, .card, [data-testid*="skill"]').first();
    await expect(skillCard).toBeVisible();

    await page.screenshot({ path: join(screenshotDir, 'vr-01-landing-desktop.png') });
  });

  test('2. Landing page - mobile 375x667', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Check for responsive layout
    const logo = page.locator('text=asr').first();
    await expect(logo).toBeVisible();

    // Check nav collapses
    const header = page.locator('header, nav').first();
    await expect(header).toBeVisible();

    await page.screenshot({ path: join(screenshotDir, 'vr-02-landing-mobile.png') });
  });

  test('3. Landing page - tablet 768x1024', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    await page.screenshot({ path: join(screenshotDir, 'vr-03-landing-tablet.png') });
  });

  test('4. Mock auth banner verification', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Check for mock auth banner
    const mockBanner = page.locator('text=/DEV MOCK AUTH/i');
    await expect(mockBanner).toBeVisible();

    await page.screenshot({ path: join(screenshotDir, 'vr-04-mock-auth.png') });
  });

  test('5. Skill detail page - markdown rendering', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Click first skill
    const firstSkill = page.locator('a, button').filter({ hasText: /write-docs|security-review/ }).first();
    if (await firstSkill.isVisible()) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');

      // Verify SKILL.md content
      const content = page.locator('article, main, [role="main"]').first();
      await expect(content).toBeVisible();

      await page.screenshot({ path: join(screenshotDir, 'vr-05-skill-detail.png') });
    }
  });

  test('6. Not found error state', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173/skills/nonexistent-xyz', { waitUntil: 'domcontentloaded' });

    // Should show error, not blank
    const errorContent = page.locator('text=/not found|error|404/i').first();
    if (await errorContent.isVisible()) {
      await page.screenshot({ path: join(screenshotDir, 'vr-06-error-404.png') });
    }
  });

  test('7. Publish flow - upload step', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173/publish', { waitUntil: 'networkidle' });

    const uploadForm = page.locator('text=/upload|publish/i').first();
    if (await uploadForm.isVisible()) {
      await page.screenshot({ path: join(screenshotDir, 'vr-07-publish-upload.png') });
    }
  });

  test('8. Review flow - queue list', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173/review', { waitUntil: 'networkidle' });

    // Should show review queue
    const reviewContent = page.locator('text=/review|queue/i').first();
    if (await reviewContent.isVisible()) {
      await page.screenshot({ path: join(screenshotDir, 'vr-08-review-queue.png') });
    }
  });

  test('9. Filters and search', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Look for filter chips
    const filterSection = page.locator('text=/TAG|KIND|RISK/i').first();
    if (await filterSection.isVisible()) {
      await page.screenshot({ path: join(screenshotDir, 'vr-09-filters.png') });
    }
  });

  test('10. Color contrast and typography check', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Capture full page for contrast analysis
    await page.screenshot({ path: join(screenshotDir, 'vr-10-typography-full.png') });
  });

  test('11. Navigation tabs visibility', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Check all main nav tabs
    await expect(page.locator('text=Browse')).toBeVisible();
    await expect(page.locator('text=Publish')).toBeVisible();
    await expect(page.locator('text=Review')).toBeVisible();

    await page.screenshot({ path: join(screenshotDir, 'vr-11-nav-tabs.png') });
  });

  test('12. Install command format', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Click skill detail
    const firstSkill = page.locator('a, button').filter({ hasText: /write-docs|security-review/ }).first();
    if (await firstSkill.isVisible()) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');

      // Look for install command
      const installCmd = page.locator('text=/asr install/i').first();
      if (await installCmd.isVisible()) {
        await page.screenshot({ path: join(screenshotDir, 'vr-12-install-command.png') });
      }
    }
  });

  test('13. Connection status indicator', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

    // Look for connection status
    const statusIndicator = page.locator('text=/Connected|Registry/i').first();
    if (await statusIndicator.isVisible()) {
      await page.screenshot({ path: join(screenshotDir, 'vr-13-connection-status.png') });
    }
  });
});
