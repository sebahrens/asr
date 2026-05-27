import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

test.describe('ASR Web UI - Visual Review 2026-05-29', () => {
  const baseURL = 'http://localhost:5173';
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const screenshotsDir = path.join(__dirname, '../../.playwright-verify');

  test.beforeAll(async () => {
    // Ensure screenshots directory exists
    const fs = await import('fs').then(m => m.promises);
    try {
      await fs.mkdir(screenshotsDir, { recursive: true });
    } catch {
      // directory may already exist
    }
  });

  test('1. Landing page - browse skills', async ({ page }) => {
    await page.goto(`${baseURL}/`);

    // Wait for skills list to load
    await page.waitForSelector('[data-testid="skill-card"]', { timeout: 5000 }).catch(() => null);

    // Take screenshots at different viewports
    for (const viewport of [
      { width: 1280, height: 800, name: 'desktop' },
      { width: 768, height: 1024, name: 'tablet' },
      { width: 375, height: 667, name: 'mobile' }
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.screenshot({
        path: `${screenshotsDir}/01-browse-${viewport.name}.png`,
        fullPage: true
      });
    }

    // Verify landing page elements
    const heading = await page.locator('h1, h2').first().textContent();
    console.log('Landing page heading:', heading);
  });

  test('2. Browse page - search functionality', async ({ page }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForSelector('[data-testid="search-input"], input[placeholder*="search" i]', { timeout: 5000 }).catch(() => null);

    // Take screenshot of search bar
    await page.screenshot({
      path: `${screenshotsDir}/02-search-bar.png`,
      fullPage: false
    });

    // Try searching (if search input exists)
    const searchInput = await page.locator('input[placeholder*="search" i], [data-testid="search-input"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
      await page.screenshot({
        path: `${screenshotsDir}/02-search-results.png`,
        fullPage: true
      });
    }
  });

  test('3. Browse page - filter chips', async ({ page }) => {
    await page.goto(`${baseURL}/`);
    await page.waitForSelector('[data-testid="filter-chip"], button:has-text("kind"), button:has-text("risk")', { timeout: 5000 }).catch(() => null);

    // Take screenshot of filters
    await page.screenshot({
      path: `${screenshotsDir}/03-filter-chips.png`,
      fullPage: true
    });
  });

  test('4. Skill detail page', async ({ page }) => {
    await page.goto(`${baseURL}/`);

    // Wait for first skill card and click it
    const firstCard = page.locator('[data-testid="skill-card"], a[href*="/skills/"]').first();
    const href = await firstCard.getAttribute('href');

    if (href) {
      await page.goto(`${baseURL}${href}`);
      await page.waitForSelector('[data-testid="skill-detail"], h1', { timeout: 5000 }).catch(() => null);

      // Take screenshots
      for (const viewport of [
        { width: 1280, height: 800, name: 'desktop' },
        { width: 375, height: 667, name: 'mobile' }
      ]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.screenshot({
          path: `${screenshotsDir}/04-detail-${viewport.name}.png`,
          fullPage: true
        });
      }
    }
  });

  test('5. Auth banner - mock mode', async ({ page }) => {
    await page.goto(`${baseURL}/`);

    // Take screenshot of header/auth area
    const header = page.locator('header, nav, [data-testid="auth-banner"]').first();
    if (await header.isVisible()) {
      await header.screenshot({
        path: `${screenshotsDir}/05-auth-banner.png`
      });
    }
  });

  test('6. Error state - 404 skill', async ({ page }) => {
    await page.goto(`${baseURL}/skills/does-not-exist-skill-id-12345`);
    await page.waitForTimeout(1000);

    // Take screenshot of error state
    await page.screenshot({
      path: `${screenshotsDir}/06-error-404.png`,
      fullPage: true
    });

    // Check what's rendered
    const bodyText = await page.locator('body').textContent();
    console.log('404 page content (first 200 chars):', bodyText?.substring(0, 200));
  });

  test('7. Empty state checks', async ({ page }) => {
    // Try to trigger empty states by searching for something unlikely
    await page.goto(`${baseURL}/`);
    const searchInput = await page.locator('input[placeholder*="search" i], [data-testid="search-input"]').first();

    if (await searchInput.isVisible()) {
      await searchInput.fill('xyzabc_very_unlikely_skill_name_12345');
      await page.waitForTimeout(500);

      await page.screenshot({
        path: `${screenshotsDir}/07-empty-search.png`,
        fullPage: true
      });
    }
  });

  test('8. Responsive layout - desktop vs mobile', async ({ page }) => {
    await page.goto(`${baseURL}/`);

    // Desktop
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({
      path: `${screenshotsDir}/08-responsive-desktop.png`,
      fullPage: true
    });

    // Mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.screenshot({
      path: `${screenshotsDir}/08-responsive-mobile.png`,
      fullPage: true
    });
  });

  test('9. Markdown rendering - skill detail SKILL.md', async ({ page }) => {
    await page.goto(`${baseURL}/`);

    // Get first skill and navigate to it
    const firstCard = page.locator('[data-testid="skill-card"], a[href*="/skills/"]').first();
    const href = await firstCard.getAttribute('href');

    if (href) {
      await page.goto(`${baseURL}${href}`);

      // Take screenshot to verify markdown rendering (code blocks, tables, etc.)
      const markdown = page.locator('[data-testid="skill-markdown"], .prose, [class*="markdown"]').first();
      if (await markdown.isVisible()) {
        await markdown.screenshot({
          path: `${screenshotsDir}/09-markdown-render.png`
        });
      }
    }
  });

  test('10. All flows summary', async ({ page }) => {
    const testResults = {
      timestamp: new Date().toISOString(),
      flows: [
        'Landing page browse',
        'Search functionality',
        'Filter chips',
        'Skill detail',
        'Auth banner',
        '404 error state',
        'Empty state',
        'Responsive layout',
        'Markdown rendering'
      ],
      screenshotCount: 9,
      baseURL
    };

    console.log('\n=== Visual Review Summary ===');
    console.log(JSON.stringify(testResults, null, 2));
  });
});
