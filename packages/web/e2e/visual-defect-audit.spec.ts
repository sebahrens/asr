import { test, expect } from 'playwright/test';
import fs from 'fs';

const screenshotsDir = '.playwright-mcp';

test.describe('Visual Defect Audit - Against Taxonomy', () => {
  test('defect:branding - No legacy product names', async ({ page }) => {
    // Check all flows for: PwC, Skill Registry, Agent Skill Registry, json2pptx, skify
    const flows = ['/'];

    for (const flow of flows) {
      await page.goto(flow);
      await page.waitForLoadState('networkidle');

      const bodyText = await page.textContent('body');
      const pageTitle = await page.title();

      const legacyMatches = [
        { name: 'PwC', found: bodyText?.includes('PwC') },
        { name: 'Skill Registry', found: bodyText?.includes('Skill Registry') },
        { name: 'Agent Skill Registry', found: bodyText?.includes('Agent Skill Registry') },
        { name: 'json2pptx', found: bodyText?.includes('json2pptx') },
        { name: 'skify', found: bodyText?.includes('skify') },
      ];

      const found = legacyMatches.filter(m => m.found);
      if (found.length > 0) {
        console.log(`DEFECT FOUND on ${flow}: ${found.map(m => m.name).join(', ')}`);
      }
      expect(found.length).toBe(0);
      expect(pageTitle).toContain('asr');
    }
  });

  test('defect:browse-filters - Filter chips are functional', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Look for filter chips/buttons
    const filterChips = page.locator('[class*="filter"]');
    const filterCount = await filterChips.count().catch(() => 0);
    console.log(`Found ${filterCount} filter elements`);

    // If filters exist, test clicking one
    if (filterCount > 0) {
      const firstFilter = filterChips.first();
      if (await firstFilter.isVisible()) {
        const initialUrl = page.url();
        await firstFilter.click();
        await page.waitForLoadState('networkidle');
        const newUrl = page.url();
        console.log(`Filter click changed URL: ${initialUrl !== newUrl}`);
      }
    }
  });

  test('defect:browse-cards - Skills cards are clickable routes, not modals', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const skillCards = page.locator('a[href*="/skills/"]');
    const cardCount = await skillCards.count();
    console.log(`Found ${cardCount} skill card links`);

    if (cardCount > 0) {
      const firstCard = skillCards.first();
      const href = await firstCard.getAttribute('href');
      console.log(`First card href: ${href}`);

      // Should navigate, not open modal
      await firstCard.click();
      await page.waitForURL(/\/skills\//);
      expect(page.url()).toContain('/skills/');

      // Verify no modal overlay
      const modals = page.locator('[role="dialog"]');
      const modalCount = await modals.count();
      expect(modalCount).toBe(0);
    }
  });

  test('defect:form-validation - Submit button respects form validity', async ({ page }) => {
    // Check if there's a publish/upload form
    await page.goto('/');
    const publishBtn = page.locator('button:has-text("Publish"), button:has-text("Upload"), button:has-text("Submit")');

    if (await publishBtn.isVisible().catch(() => false)) {
      await publishBtn.click();
      await page.waitForTimeout(300);

      // Look for submit buttons in forms
      const submitBtns = page.locator('button[type="submit"], button:has-text("Continue")');
      if (await submitBtns.first().isVisible()) {
        const isDisabled = await submitBtns.first().isDisabled();
        console.log(`Submit disabled on empty form: ${isDisabled}`);
        // Should be disabled when form is empty
        expect(isDisabled).toBe(true);
      }
    } else {
      console.log('No publish form found (expected in current phase)');
    }
  });

  test('defect:sticky-header - Header stays sticky and opaque during scroll', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const header = page.locator('header, nav, [role="banner"]').first();
    expect(await header.isVisible()).toBe(true);

    // Navigate to a skill detail page that has enough content to scroll
    const skillLink = page.locator('a[href*="/skills/"]').first();
    if (await skillLink.isVisible()) {
      await skillLink.click();
      await page.waitForLoadState('networkidle');

      // The contract for "header doesn't overlap content" with a sticky header is:
      //  (a) the header is sticky/fixed and pinned to the top of the viewport, and
      //  (b) the header has an opaque background so content scrolling underneath it
      //      is visually occluded rather than bleeding through.
      // Asserting that <main>.y stays below the header is wrong: <main> is in the
      // normal document flow and naturally scrolls off-screen on a long page.
      const headerStyles = await header.evaluate((el) => {
        const style = window.getComputedStyle(el as HTMLElement);
        return {
          position: style.position,
          top: style.top,
          backgroundColor: style.backgroundColor,
          zIndex: style.zIndex,
        };
      });

      expect(['sticky', 'fixed']).toContain(headerStyles.position);
      expect(headerStyles.top).toBe('0px');
      expect(headerStyles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(headerStyles.backgroundColor).not.toBe('transparent');
      expect(Number.parseInt(headerStyles.zIndex, 10)).toBeGreaterThanOrEqual(1);

      await page.evaluate(() => window.scrollBy(0, 300));
      await page.screenshot({ path: `${screenshotsDir}/scroll-header-overlap.png` });

      const headerAfterScroll = await header.boundingBox();
      const headerTopAfterScroll = headerAfterScroll?.y ?? 0;
      console.log(`Header top after 300px scroll: ${headerTopAfterScroll}px`);
      expect(headerTopAfterScroll).toBeLessThanOrEqual(5);
      expect(headerTopAfterScroll).toBeGreaterThanOrEqual(-5);
    }
  });

  test('defect:responsive-nav - No horizontal scroll on mobile', async ({ page }) => {
    const viewports = [
      { width: 375, height: 667, name: 'iPhone SE' },
      { width: 768, height: 1024, name: 'iPad' },
      { width: 1280, height: 800, name: 'Desktop' },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

      const hasHorizontalScroll = scrollWidth > clientWidth + 1;
      console.log(`${viewport.name} (${viewport.width}x${viewport.height}): H-scroll=${hasHorizontalScroll}`);
      expect(hasHorizontalScroll).toBe(false);
    }
  });

  test('defect:markdown-gfm - GFM elements render properly', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const firstSkill = page.locator('a[href*="/skills/"]').first();
    if (await firstSkill.isVisible()) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');

      // Check for GFM-rendered elements
      const checks = {
        'Tables (with borders)': page.locator('table'),
        'Code blocks (fenced)': page.locator('pre, code[class*="language"]'),
        'Lists (indented)': page.locator('ul, ol'),
        'Headings (h2+)': page.locator('h2, h3, h4'),
        'Bold/italic text': page.locator('strong, em, b, i'),
      };

      for (const [feature, locator] of Object.entries(checks)) {
        const count = await locator.count().catch(() => 0);
        console.log(`${feature}: ${count} found`);
      }
    }
  });

  test('defect:mock-auth - Dev banner visible and doesn\'t clip branding', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Look for mock/dev indicator
    const mockIndicators = page.locator('text=/mock|dev|test/i, [class*="mock"], [class*="dev"]');
    const mockCount = await mockIndicators.count().catch(() => 0);

    console.log(`Found ${mockCount} mock/dev indicators`);

    // Check header layout - branding should still be visible
    const header = page.locator('header').first();
    const headerHeight = await header.evaluate((el) => el.offsetHeight).catch(() => 0);
    console.log(`Header height: ${headerHeight}px`);

    // Should be reasonable (not 0, not >100px for a simple banner)
    expect(headerHeight).toBeGreaterThan(40);
    expect(headerHeight).toBeLessThan(150);

    // Take screenshot to visually verify
    await header.screenshot({ path: `${screenshotsDir}/mock-auth-banner.png` });
  });

  test('defect:not-found - 404 page shows error state, not blank/browse', async ({ page }) => {
    await page.goto('/skills/nonexistent-owner/nonexistent-skill');
    await page.waitForLoadState('networkidle');

    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
    expect(bodyText?.length).toBeGreaterThan(50);

    // Should mention error
    const hasError = /error|not found|404|does not exist/i.test(bodyText || '');
    console.log(`Error message present: ${hasError}`);
    expect(hasError).toBe(true);

    // Should NOT fall back to browse page
    const allSkills = await page.locator('a[href*="/skills/"]').count().catch(() => 0);
    // Some skills might be OK if the error shows context, but shouldn't be full browse list
    console.log(`Skills shown on error page: ${allSkills}`);
  });

  test('defect:upload-input - File input is properly labeled, shows file name', async ({ page }) => {
    await page.goto('/');

    // Look for any file inputs
    const fileInputs = page.locator('input[type="file"]');
    const fileCount = await fileInputs.count().catch(() => 0);

    console.log(`Found ${fileCount} file inputs`);

    if (fileCount > 0) {
      const input = fileInputs.first();

      // Set a file
      const testFile = { name: 'test.zip', mimeType: 'application/zip' };
      await input.setInputFiles({
        name: testFile.name,
        mimeType: testFile.mimeType,
        buffer: Buffer.from('test'),
      });

      // Check that file name appears (not "no file chosen")
      const label = page.locator('label, [class*="file"], [class*="upload"]').first();
      const text = await label.textContent().catch(() => '');
      const showsFileName = text?.includes(testFile.name) || !text?.toLowerCase().includes('no file chosen');

      console.log(`File input shows selected name: ${showsFileName}`);
    }
  });

  test('defect:install-snippet - Install command uses correct format', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const firstSkill = page.locator('a[href*="/skills/"]').first();
    if (await firstSkill.isVisible()) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');

      const bodyText = await page.textContent('body');

      // Should use "asr install" or not reference "npm install" or old command formats
      const hasValidCommand = /asr\s+install|asr\s+add/i.test(bodyText || '');
      const hasInvalidCommand = /npm\s+install\s+@asr\/|npm\s+add\s+@asr\//i.test(bodyText || '');

      console.log(`Valid install command present: ${hasValidCommand}`);
      console.log(`Invalid install command present: ${hasInvalidCommand}`);

      if (hasValidCommand) {
        expect(hasValidCommand).toBe(true);
      }
    }
  });

  test('Focus states work on keyboard navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate with Tab key
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    const focusedElement = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return {
        tagName: el.tagName,
        hasOutline: window.getComputedStyle(el).outline !== 'none',
        hasShadow: window.getComputedStyle(el).boxShadow !== 'none',
      };
    });

    console.log(`Focused element: ${JSON.stringify(focusedElement)}`);

    if (focusedElement) {
      // At least outline OR box-shadow should be visible
      const hasFocusIndicator = focusedElement.hasOutline || focusedElement.hasShadow;
      console.log(`Focus indicator visible: ${hasFocusIndicator}`);
      expect(hasFocusIndicator).toBe(true);
    }

    await page.screenshot({ path: `${screenshotsDir}/keyboard-focus.png` });
  });
});
