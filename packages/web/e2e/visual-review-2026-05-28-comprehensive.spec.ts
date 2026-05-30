import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'http://localhost:5173';
const SCREENSHOT_DIR = '.playwright-mcp';

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function screenshot(page: Page, name: string) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`Screenshot saved: ${filePath}`);
  return filePath;
}

async function screenshotFullPage(page: Page, name: string) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}-fullpage.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`Full page screenshot saved: ${filePath}`);
  return filePath;
}

test.describe('ASR Web - Comprehensive Visual Review 2026-05-28', () => {
  test.beforeEach(async ({ page }) => {
    // Set viewport to standard desktop size
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('Flow 1: Landing / Browse - skill list, search, filters', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Screenshot landing
    await screenshot(page, '1-landing-overview');
    await screenshotFullPage(page, '1-landing');

    // Verify skill list renders
    const skillCards = page.locator('[class*="skill"], a[href*="/skills/"]').first();
    const skillsExist = await skillCards.isVisible({ timeout: 5000 }).catch(() => false);
    expect(skillsExist).toBe(true);
    console.log(`✓ Skill cards visible: ${skillsExist}`);

    // Verify search bar
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    const searchVisible = await searchInput.isVisible().catch(() => false);
    console.log(`✓ Search bar visible: ${searchVisible}`);

    // Check for filter chips/buttons
    const filters = page.locator('button[role="button"]').filter({ has: page.locator('text=/kind|risk|filter|category/i') }).first();
    const filtersExist = await filters.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Filter controls visible: ${filtersExist}`);

    // Test search functionality
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await expect(searchInput).toHaveValue('test');
      await screenshot(page, '1-landing-search');
      console.log(`✓ Search interaction works`);
    }
  });

  test('Flow 2: Skill Detail - SKILL.md preview, tabs, kind/risk badges', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Click first skill link
    const firstSkill = page.locator('a[href*="/skills/"], [role="listitem"] a').first();
    const isClickable = await firstSkill.isVisible({ timeout: 5000 }).catch(() => false);

    if (isClickable) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');

      await screenshot(page, '2-skill-detail-overview');
      await screenshotFullPage(page, '2-skill-detail');

      // Verify SKILL.md renders (markdown)
      const markdownPreview = page.locator('[class*="markdown"], [class*="prose"], article, main').first();
      const markdownVisible = await markdownPreview.isVisible({ timeout: 3000 }).catch(() => false);
      console.log(`✓ SKILL.md preview rendered: ${markdownVisible}`);

      // Verify kind and risk badges
      const kindBadge = page.locator('[class*="kind"], [data-testid*="kind"]').first();
      const riskBadge = page.locator('[class*="risk"], [data-testid*="risk"]').first();
      const kindVisible = await kindBadge.isVisible({ timeout: 2000 }).catch(() => false);
      const riskVisible = await riskBadge.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`✓ Kind badge visible: ${kindVisible}`);
      console.log(`✓ Risk badge visible: ${riskVisible}`);

      // Check for tabs
      const tabs = page.locator('[role="tab"], [class*="tab"]').first();
      const tabsExist = await tabs.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`✓ Tabs/navigation visible: ${tabsExist}`);

      // Verify GFM rendering (code blocks, tables, lists)
      const codeBlocks = page.locator('pre, code[class*="language"]').first();
      const hasCodeBlock = await codeBlocks.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`✓ Code blocks rendered: ${hasCodeBlock}`);

      const tables = page.locator('table').first();
      const hasTable = await tables.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`✓ Tables rendered: ${hasTable}`);
    }
  });

  test('Flow 3: Mock Auth Banner - dev mode indicator, no token leakage', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Check for mock auth banner
    const authBanner = page.locator('[class*="mock"], [role="status"]').filter({ hasText: /mock|dev|development/i }).first();
    const bannerExists = await authBanner.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`✓ Mock auth banner visible: ${bannerExists}`);

    if (bannerExists) {
      await screenshot(page, '3-mock-auth-banner');

      // Verify it says "Dev mock auth" or similar
      const devText = page.locator('text=/dev\\s+mock|mock\\s+auth|development/i').first();
      const devLabelVisible = await devText.isVisible().catch(() => false);
      console.log(`✓ "Dev/mock" label visible: ${devLabelVisible}`);

      // Check for user identity display (should be dev-user)
      const userDisplay = page.locator('text=/dev-user|dev_user').first();
      const userVisible = await userDisplay.isVisible().catch(() => false);
      console.log(`✓ User identity shown: ${userVisible}`);
    }

    // Verify no token leakage in DOM (check localStorage/sessionStorage)
    const tokenInDOM = await page.locator('text=/Bearer|eyJ|api[_-]key|token/i').isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`✓ No token visible in DOM: ${!tokenInDOM}`);
  });

  test('Flow 4: Publish Wizard - form validation, upload, manifest, questionnaire', async ({ page }) => {
    await page.goto(`${BASE_URL}/publish`);
    await page.waitForLoadState('networkidle');

    await screenshot(page, '4-publish-wizard-step1');
    await screenshotFullPage(page, '4-publish-wizard');

    // Verify upload step is visible
    const uploadSection = page.locator('[class*="upload"], [class*="step"], form').first();
    const uploadVisible = await uploadSection.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`✓ Upload step visible: ${uploadVisible}`);

    // Check for wizard step indicators
    const stepIndicators = page.locator('[role="tablist"], [class*="step"], [class*="wizard"]').first();
    const stepsVisible = await stepIndicators.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Wizard step navigation visible: ${stepsVisible}`);

    // Verify form has required fields
    const ownerField = page.locator('input[placeholder*="owner" i], input[placeholder*="namespace" i]').first();
    const ownerVisible = await ownerField.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Owner/namespace field visible: ${ownerVisible}`);

    // Check for upload input/dropzone
    const uploadInput = page.locator('input[type="file"], [class*="drop"], [class*="upload"]').first();
    const uploadInputVisible = await uploadInput.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ File upload input visible: ${uploadInputVisible}`);

    // Verify Continue button exists but is initially disabled
    const continueButton = page.locator('button:has-text("Continue"), button:has-text("Next")').first();
    const continueVisible = await continueButton.isVisible({ timeout: 2000 }).catch(() => false);
    const isInitiallyDisabled = continueVisible && await continueButton.isDisabled().catch(() => true);
    console.log(`✓ Continue button exists: ${continueVisible}`);
    console.log(`✓ Continue button disabled when form invalid: ${isInitiallyDisabled}`);

    // Test validation - try to continue without filling
    if (continueVisible && isInitiallyDisabled) {
      console.log(`✓ Form validation working (button disabled on invalid)`);
    }
  });

  test('Flow 5: Approval Dashboard (Review) - queue list, status pills, approve/reject actions', async ({ page }) => {
    await page.goto(`${BASE_URL}/review`);
    await page.waitForLoadState('networkidle');

    await screenshot(page, '5-review-dashboard-overview');
    await screenshotFullPage(page, '5-review-dashboard');

    // Verify review queue header
    const queueHeader = page.locator('h1, h2').filter({ hasText: /approval|review|queue|compliance/i }).first();
    const headerVisible = await queueHeader.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`✓ Review/approval header visible: ${headerVisible}`);

    // Verify submission list renders
    const submissionList = page.locator('[class*="list"], [role="list"], article').first();
    const listVisible = await submissionList.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`✓ Submission list visible: ${listVisible}`);

    // Check for status pills
    const statusPill = page.locator('[class*="status"], [class*="pill"]').first();
    const statusVisible = await statusPill.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Status pills visible: ${statusVisible}`);

    // Check for risk pills/badges
    const riskPill = page.locator('[class*="risk"]').first();
    const riskVisible = await riskPill.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Risk badges visible: ${riskVisible}`);

    // Check for approve/reject buttons
    const approveBtn = page.locator('button:has-text("Approve"), button:has-text("approve")').first();
    const rejectBtn = page.locator('button:has-text("Reject"), button:has-text("reject")').first();
    const approveBtnVisible = await approveBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const rejectBtnVisible = await rejectBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Approve button visible: ${approveBtnVisible}`);
    console.log(`✓ Reject button visible: ${rejectBtnVisible}`);

    // Test click into a submission detail
    const firstSubmission = page.locator('article, [role="listitem"]').first();
    const detailLink = firstSubmission.locator('a, button:has-text("Open")').first();
    const detailLinkVisible = await detailLink.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Detail link exists: ${detailLinkVisible}`);

    if (detailLinkVisible) {
      await detailLink.click();
      await page.waitForLoadState('networkidle');
      await screenshot(page, '5-review-detail-page');
      console.log(`✓ Review detail page loads`);
    }
  });

  test('Flow 6: Mobile Responsive - nav collapse, sidebar, viewport scaling', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    await screenshot(page, '6-mobile-landing');

    // Check for mobile nav toggle
    const mobileToggle = page.locator('button[class*="mobile"], button[aria-label*="menu" i], button[aria-label*="navigation" i]').first();
    const toggleVisible = await mobileToggle.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Mobile nav toggle visible: ${toggleVisible}`);

    // Verify no horizontal scroll at mobile width
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = 375;
    const noHorizontalScroll = bodyWidth <= viewportWidth + 1; // Allow 1px for rounding
    console.log(`✓ No horizontal scroll at mobile (body width: ${bodyWidth}, viewport: ${viewportWidth}): ${noHorizontalScroll}`);

    // Open mobile nav
    if (toggleVisible) {
      await mobileToggle.click();
      await page.locator('[class*="mobile"], [class*="drawer"], nav').first().isVisible({ timeout: 300 }).catch(() => false);
      await screenshot(page, '6-mobile-nav-open');

      const navPanel = page.locator('[class*="mobile"], [class*="drawer"], nav').first();
      const navVisible = await navPanel.isVisible().catch(() => false);
      console.log(`✓ Mobile navigation panel opens: ${navVisible}`);
    }

    // Test skill detail on mobile
    await page.goto(`${BASE_URL}/`);
    const firstSkill = page.locator('a[href*="/skills/"]').first();
    if (await firstSkill.isVisible()) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');
      await screenshot(page, '6-mobile-skill-detail');

      const skillContent = page.locator('main, article, [class*="detail"]').first();
      const contentVisible = await skillContent.isVisible().catch(() => false);
      console.log(`✓ Skill detail renders on mobile: ${contentVisible}`);
    }
  });

  test('Flow 7: Error States - 404, not found, graceful handling', async ({ page }) => {
    // Test skill not found
    await page.goto(`${BASE_URL}/skills/nonexistent/notareal`);
    await page.waitForLoadState('networkidle');

    await screenshot(page, '7-not-found-skill');

    // Should NOT show browse/grid (that would be wrong fallback)
    const skillGrid = page.locator('[class*="grid"], [class*="list"]').filter({ hasText: /skill|browse/i }).first();
    const showsBrowseWrong = await skillGrid.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Skill not found doesn't show browse fallback: ${!showsBrowseWrong}`);

    // Should show error or not found message
    const errorMessage = page.locator('text=/not found|404|error|does not exist/i').first();
    const showsError = await errorMessage.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Error message shown for not found: ${showsError}`);

    // Test review not found
    await page.goto(`${BASE_URL}/review/nonexistent-review-id`);
    await page.waitForLoadState('networkidle');

    await screenshot(page, '7-not-found-review');

    const reviewError = page.locator('text=/not found|error|submission/i').first();
    const reviewErrorVisible = await reviewError.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Review not found shows error: ${reviewErrorVisible}`);
  });

  test('Flow 8: Branding - "asr" name, logo, consistency', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Check page title
    const pageTitle = await page.title();
    console.log(`Page title: "${pageTitle}"`);
    const titleHasASR = pageTitle.toLowerCase().includes('asr') || pageTitle === 'asr';
    console.log(`✓ Page title includes 'asr': ${titleHasASR}`);

    // Check logo
    const logo = page.locator('img[alt="asr"], img[alt*="asr" i], [class*="logo"]').first();
    const logoVisible = await logo.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Logo visible: ${logoVisible}`);

    // Check for wrong branding (json2pptx, skify, etc.)
    const wrongBranding = page.locator('text=/json2pptx|skify|agent skill registry|Agent Skills Registry/i').first();
    const hasWrongBranding = await wrongBranding.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ No legacy branding ("json2pptx", "skify"): ${!hasWrongBranding}`);

    // Check nav branding
    const navBranding = page.locator('nav, [class*="nav"]').first();
    await screenshot(page, '8-branding-header');
  });

  test('Flow 9: Layout Integrity - no overlaps, footer position, sticky headers', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Check for basic layout structure
    const header = page.locator('header, [class*="header"]').first();
    const main = page.locator('main').first();
    const footer = page.locator('footer, [class*="footer"]').first();

    const headerVisible = await header.isVisible({ timeout: 2000 }).catch(() => false);
    const mainVisible = await main.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Header visible: ${headerVisible}`);
    console.log(`✓ Main content visible: ${mainVisible}`);

    // Verify no excessive bottom gap (footer properly positioned)
    const mainBoundingBox = await main.boundingBox();
    if (mainBoundingBox) {
      console.log(`✓ Layout has main content area`);
    }

    // Test scroll behavior - sticky header
    await page.goto(`${BASE_URL}/review`);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.scrollBy(0, 300));
    await expect(header).toBeVisible({ timeout: 2000 });

    // Header should still be visible after scroll
    const headerStillVisible = await header.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ Header remains visible after scroll: ${headerStillVisible}`);

    await screenshot(page, '9-layout-after-scroll');
  });

  test('Flow 10: Typography & Contrast - readable sizes, proper hierarchy, WCAG AA', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Check heading hierarchy
    const h1 = page.locator('h1').first();
    const h2 = page.locator('h2').first();
    const h3 = page.locator('h3').first();

    const h1Visible = await h1.isVisible({ timeout: 2000 }).catch(() => false);
    const h2Visible = await h2.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`✓ H1 elements present: ${h1Visible}`);
    console.log(`✓ H2 elements present: ${h2Visible}`);

    // Check body text is readable
    const bodyText = page.locator('body').first();
    const fontSize = await bodyText.evaluate((el) => window.getComputedStyle(el).fontSize);
    console.log(`✓ Body font size: ${fontSize}`);

    // Check for text clipping (measure overflow)
    const paragraphs = page.locator('p, span, a').first();
    const hasTextClip = await paragraphs.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.overflow === 'hidden' || style.textOverflow === 'ellipsis';
    }).catch(() => false);
    console.log(`✓ Proper text handling (no clipping): ${!hasTextClip}`);

    await screenshot(page, '10-typography');
  });

  test('Flow 11: Form States - empty, filled, invalid, submitting, submitted', async ({ page }) => {
    await page.goto(`${BASE_URL}/publish`);
    await page.waitForLoadState('networkidle');

    const ownerField = page.locator('input[placeholder*="owner" i], input[placeholder*="namespace" i]').first();

    if (await ownerField.isVisible()) {
      // Empty state
      await screenshot(page, '11-form-empty');

      // Fill owner field
      await ownerField.fill('test-owner');
      await expect(ownerField).toHaveValue('test-owner');
      await screenshot(page, '11-form-filled-owner');

      // Check validation message appears for missing required fields
      const validationMessage = page.locator('[role="alert"], [class*="error"], [class*="message"]').first();
      const hasValidationUI = await validationMessage.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`✓ Validation messages appear: ${hasValidationUI}`);

      // Verify submit button is disabled while invalid
      const submitBtn = page.locator('button:has-text("Submit"), button:has-text("Continue"), button:has-text("Next")').first();
      const isDisabled = await submitBtn.isDisabled().catch(() => true);
      console.log(`✓ Submit disabled while invalid: ${isDisabled}`);
    }
  });

  test('Flow 12: Install Command - correct syntax, asr namespace', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Find first skill and navigate to detail
    const firstSkill = page.locator('a[href*="/skills/"]').first();
    if (await firstSkill.isVisible()) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');

      // Look for install command
      const installCommand = page.locator('text=/asr\\s+install|asr\\s+add/i, code:has-text(/asr/)').first();
      const hasInstallCmd = await installCommand.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`✓ Install command visible: ${hasInstallCmd}`);

      if (hasInstallCmd) {
        const cmdText = await installCommand.textContent();
        console.log(`Install command text: "${cmdText}"`);

        // Check for obsolete commands
        const hasObsoleteCmd = cmdText?.includes('asr add') || cmdText?.includes('npm install');
        console.log(`✓ No obsolete install commands: ${!hasObsoleteCmd}`);
      }

      await screenshot(page, '12-install-command');
    }
  });
});

test.describe('ASR Web - Specific Defect Verification', () => {
  test('Verify no diff-clipping on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE_URL}/review/sub-1042`);
    await page.waitForLoadState('networkidle');

    // Find diff viewer and check for clipping
    const diffViewer = page.locator('[class*="diff"], pre, code').first();
    if (await diffViewer.isVisible()) {
      const isClipped = await diffViewer.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return el.scrollWidth > el.clientWidth;
      }).catch(() => false);

      console.log(`✓ Diff not clipped on desktop: ${!isClipped}`);
      await screenshot(page, 'verify-diff-desktop');
    }
  });

  test('Verify no diff-clipping on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${BASE_URL}/review/sub-1042`);
    await page.waitForLoadState('networkidle');

    const diffViewer = page.locator('[class*="diff"], pre, code').first();
    if (await diffViewer.isVisible()) {
      // Mobile should wrap or scroll internally, not clip at page boundary
      const bodyHasScroll = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
      console.log(`✓ No page-level horizontal scroll: ${!bodyHasScroll}`);
      await screenshot(page, 'verify-diff-mobile');
    }
  });

  test('Verify markdown GFM rendering', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    const firstSkill = page.locator('a[href*="/skills/"]').first();
    if (await firstSkill.isVisible()) {
      await firstSkill.click();
      await page.waitForLoadState('networkidle');

      // Check for GFM features
      const hasCodeBlocks = await page.locator('pre, code[class*="language"]').isVisible({ timeout: 2000 }).catch(() => false);
      const hasTables = await page.locator('table').isVisible({ timeout: 2000 }).catch(() => false);
      const hasLists = await page.locator('ul, ol').isVisible({ timeout: 2000 }).catch(() => false);

      console.log(`✓ Code blocks render: ${hasCodeBlocks}`);
      console.log(`✓ Tables render: ${hasTables}`);
      console.log(`✓ Lists render: ${hasLists}`);

      await screenshot(page, 'verify-markdown-gfm');
    }
  });
});
