import { chromium } from 'playwright';
import * as fs from 'fs';

const BASE_URL = 'http://localhost:5173';
const SCREENSHOT_DIR = '.playwright-mcp';

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function captureFlow() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  console.log('🔍 Starting visual review at', new Date().toISOString());
  const findings = [];

  try {
    // Flow 1: Landing page / browse
    console.log('\n📄 Flow 1: Landing page');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-landing.png`, fullPage: true });

    // Check for skill list
    const skillCards = await page.locator('[data-testid*="skill"], .skill-card').count();
    console.log(`  ✓ Skill cards visible: ${skillCards}`);

    // Check for search bar
    const searchBar = await page.locator('input[type="search"], [placeholder*="search" i]').isVisible();
    console.log(`  ✓ Search bar visible: ${searchBar}`);

    // Check branding
    const appTitle = await page.title();
    console.log(`  ✓ Page title: "${appTitle}"`);
    if (!appTitle.toLowerCase().includes('asr')) {
      findings.push('⚠️ defect:branding - page title does not include "asr"');
    }

    // Check for filter chips
    const filterButtons = await page.locator('button:has-text("kind"), button:has-text("risk"), button:has-text("tag")').count();
    console.log(`  ✓ Filter controls found: ${filterButtons}`);

    // Flow 2: Skill detail
    console.log('\n📄 Flow 2: Skill detail');
    const firstSkillLink = page.locator('a[href*="/skill"], [role="link"]:first-child').first();
    const firstSkillText = await firstSkillLink.textContent();
    console.log(`  Navigating to first skill: ${firstSkillText?.substring(0, 40)}...`);

    await firstSkillLink.click({ timeout: 5000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-skill-detail.png`, fullPage: true });

    // Check for markdown content
    const skillmdContent = await page.locator('code, pre, table, h2, h3').count();
    console.log(`  ✓ Markdown elements (code/pre/table/headings): ${skillmdContent}`);

    if (skillmdContent === 0) {
      findings.push('⚠️ defect:markdown-gfm - No markdown elements detected in skill detail');
    }

    // Flow 3: Auth banner check
    console.log('\n📄 Flow 3: Auth state');
    const authBanner = await page.locator('text=/mock|dev|auth/i, [role="banner"], [aria-label*="auth"]').first();
    const authVisible = await authBanner.isVisible().catch(() => false);
    console.log(`  ✓ Auth banner visible: ${authVisible}`);

    // Flow 4: Not found error state
    console.log('\n📄 Flow 4: Not found state');
    await page.goto(`${BASE_URL}/skills/nonexistent-skill-xyz`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-not-found.png`, fullPage: true });

    const errorContent = await page.textContent('body');
    const has404Text = errorContent?.includes('404') || errorContent?.includes('not found');
    console.log(`  ✓ Error message displayed: ${has404Text}`);

    if (!has404Text) {
      findings.push('⚠️ defect:not-found - No error message visible for non-existent skill');
    }

    // Flow 5: Check for review/approval routes
    console.log('\n📄 Flow 5: Review/Approval dashboard');
    await page.goto(`${BASE_URL}/review`, { waitUntil: 'load' }).catch(() => {
      console.log('  (Review route not available yet - expected during development)');
    });
    await page.waitForTimeout(500);
    const reviewScreenshot = await page.screenshot({ path: `${SCREENSHOT_DIR}/04-review.png`, fullPage: true });
    console.log(`  ✓ Review page screenshot captured`);

    // Flow 6: Responsive check
    console.log('\n📄 Flow 6: Responsive layout');
    await page.setViewportSize({ width: 375, height: 667 }); // Mobile viewport
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-mobile.png`, fullPage: true });

    // Check for horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = 375;
    console.log(`  ✓ Body width: ${bodyWidth}px, viewport: ${viewportWidth}px`);

    if (bodyWidth > viewportWidth) {
      findings.push(`⚠️ defect:responsive-nav - Horizontal scroll detected on mobile (body: ${bodyWidth}px > viewport: ${viewportWidth}px)`);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Visual Review Summary');
    console.log('='.repeat(60));
    console.log(`Screenshots: ${SCREENSHOT_DIR}/`);
    console.log(`Total findings: ${findings.length}`);

    if (findings.length > 0) {
      console.log('\nFindings:');
      findings.forEach(f => console.log(`  ${f}`));
    } else {
      console.log('✅ No defects found in canonical taxonomy');
    }

  } catch (error) {
    console.error('❌ Error during visual review:', error.message);
    findings.push(`ERROR: ${error.message}`);
  } finally {
    await context.close();
    await browser.close();
  }

  return findings;
}

captureFlow().then(findings => {
  process.exit(findings.some(f => f.startsWith('ERROR')) ? 1 : 0);
});
