import playwright from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:5173';
const SCREENSHOT_DIR = '.playwright-mcp';
const VIEWPORT = { width: 1280, height: 800 };

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const defects = [];
const screenshots = [];

async function captureAndAnalyze() {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();

  // Set viewport for consistent testing
  await page.setViewportSize(VIEWPORT);

  console.log('Starting visual review...\n');

  try {
    // Flow 1: Landing / Browse
    console.log('=== Flow 1: Landing / Browse ===');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    let fileName = `1-landing.png`;
    let filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath });
    screenshots.push({ flow: 'Landing', file: filePath });
    console.log(`✓ Captured: ${filePath}`);

    // Check for skill list rendering
    const skillList = await page.locator('[data-testid="skill-list"], [class*="skill"], main').first().isVisible();
    if (!skillList) {
      console.warn('⚠ Skill list may not be visible');
      defects.push({
        category: 'browse-filters',
        flow: 'Landing',
        description: 'Skill list not visible on landing page'
      });
    }

    // Check for legacy branding
    const pageContent = await page.content();
    if (pageContent.match(/skify|json2pptx|PwC|Skill Registry(?!\s+\(ASR\))/i)) {
      console.warn('✗ Found legacy branding');
      defects.push({
        category: 'branding',
        flow: 'Landing',
        description: 'Legacy branding found in page content'
      });
    } else {
      console.log('✓ Branding looks correct');
    }

    // Flow 2: Search and filter
    console.log('\n=== Flow 2: Search & Filters ===');
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForLoadState('networkidle');
      fileName = `2-search-results.png`;
      filePath = path.join(SCREENSHOT_DIR, fileName);
      await page.screenshot({ path: filePath });
      screenshots.push({ flow: 'Search', file: filePath });
      console.log(`✓ Captured: ${filePath}`);
      await searchInput.clear();
    } else {
      console.warn('⚠ Search input not found');
      defects.push({
        category: 'browse-filters',
        flow: 'Search',
        description: 'Search input not visible on landing page'
      });
    }

    // Flow 3: Skill detail
    console.log('\n=== Flow 3: Skill Detail ===');
    // Try to find and click first skill card
    const firstSkillLink = page.locator('a[href*="/skills/"], [role="link"]:has-text("test")').first();
    if (await firstSkillLink.isVisible()) {
      await firstSkillLink.click();
      await page.waitForLoadState('networkidle');
      fileName = `3-skill-detail.png`;
      filePath = path.join(SCREENSHOT_DIR, fileName);
      await page.screenshot({ path: filePath });
      screenshots.push({ flow: 'Skill Detail', file: filePath });
      console.log(`✓ Captured: ${filePath}`);

      // Check markdown rendering
      const markdownContent = page.locator('[class*="markdown"], code, pre, table');
      const hasMarkdown = await markdownContent.first().isVisible().catch(() => false);
      if (!hasMarkdown) {
        console.warn('⚠ Markdown content may not be rendering');
        defects.push({
          category: 'markdown-gfm',
          flow: 'Skill Detail',
          description: 'No markdown elements visible in skill detail'
        });
      }
    } else {
      console.log('ℹ No skills available to click (using mock API with no data)');
    }

    // Flow 4: 404 Error state
    console.log('\n=== Flow 4: 404 Error State ===');
    await page.goto(`${BASE_URL}/skills/does-not-exist`, { waitUntil: 'networkidle' });
    fileName = `4-not-found.png`;
    filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath });
    screenshots.push({ flow: '404 Error', file: filePath });
    console.log(`✓ Captured: ${filePath}`);

    // Check if page shows error state or falls back to browse
    const errorMsg = await page.locator('text=/not found|does not exist|404/i').isVisible().catch(() => false);
    const browseContent = await page.locator('[class*="skill"], main').first().isVisible().catch(() => false);

    if (!errorMsg && !browseContent) {
      console.warn('✗ Unknown skill route renders blank screen');
      defects.push({
        category: 'not-found',
        flow: '404 Error',
        description: 'Unknown skill route renders blank instead of error state'
      });
    } else if (errorMsg) {
      console.log('✓ Error state is displayed');
    } else {
      console.log('ℹ Falls back to browse view for unknown skill');
    }

    // Flow 5: Publish/Upload
    console.log('\n=== Flow 5: Publish/Upload ===');
    await page.goto(`${BASE_URL}/publish`, { waitUntil: 'networkidle' });
    fileName = `5-publish.png`;
    filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath });
    screenshots.push({ flow: 'Publish', file: filePath });
    console.log(`✓ Captured: ${filePath}`);

    // Check form elements
    const formInputs = page.locator('input[type="text"], input[type="file"], textarea, select');
    const inputCount = await formInputs.count();
    console.log(`  Found ${inputCount} form inputs`);

    const submitButton = page.locator('button[type="submit"]').first();
    if (await submitButton.isVisible()) {
      // Check if submit is disabled
      const isDisabled = await submitButton.isDisabled();
      console.log(`  Submit button visible (disabled: ${isDisabled})`);
      if (!isDisabled) {
        console.warn('⚠ Submit button should be disabled while form is empty');
        defects.push({
          category: 'form-validation',
          flow: 'Publish',
          description: 'Submit button is enabled when form is empty'
        });
      }
    }

    // Flow 6: Approval Dashboard (if exists)
    console.log('\n=== Flow 6: Approval Dashboard ===');
    await page.goto(`${BASE_URL}/review`, { waitUntil: 'networkidle', timeout: 5000 }).catch(() => {
      console.log('ℹ /review route not available (expected in dev mode)');
    });

    const reviewPageExists = page.url().includes('/review');
    if (reviewPageExists) {
      fileName = `6-review-dashboard.png`;
      filePath = path.join(SCREENSHOT_DIR, fileName);
      await page.screenshot({ path: filePath });
      screenshots.push({ flow: 'Review Dashboard', file: filePath });
      console.log(`✓ Captured: ${filePath}`);
    }

    // Flow 7: Mobile responsiveness check
    console.log('\n=== Flow 7: Responsive (Mobile) ===');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    fileName = `7-mobile-landing.png`;
    filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath });
    screenshots.push({ flow: 'Mobile Landing', file: filePath });
    console.log(`✓ Captured: ${filePath}`);

    // Check for horizontal scroll
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = 375;
    if (bodyWidth > viewportWidth) {
      console.warn(`⚠ Horizontal scroll detected on mobile (body: ${bodyWidth}px, viewport: ${viewportWidth}px)`);
      defects.push({
        category: 'responsive-nav',
        flow: 'Mobile',
        description: `Horizontal scroll on mobile: ${bodyWidth}px body width exceeds ${viewportWidth}px viewport`
      });
    }

    // Flow 8: Auth state (mock)
    console.log('\n=== Flow 8: Mock Auth Banner ===');
    await page.setViewportSize(VIEWPORT);
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    const authBanner = page.locator('[class*="auth"], [class*="mock"], [class*="dev"]').first();
    const hasMockBanner = await authBanner.isVisible().catch(() => false);
    console.log(`  Mock auth banner visible: ${hasMockBanner}`);

  } catch (error) {
    console.error('Error during visual review:', error.message);
    defects.push({
      category: 'other',
      flow: 'Runtime Error',
      description: error.message
    });
  } finally {
    await browser.close();
  }

  // Summary report
  console.log('\n' + '='.repeat(60));
  console.log('VISUAL REVIEW SUMMARY');
  console.log('='.repeat(60));

  console.log(`\nScreenshots captured: ${screenshots.length}`);
  screenshots.forEach(s => {
    console.log(`  • ${s.flow}: ${s.file}`);
  });

  console.log(`\nDefects found: ${defects.length}`);
  if (defects.length > 0) {
    const byCategory = {};
    defects.forEach(d => {
      if (!byCategory[d.category]) {
        byCategory[d.category] = [];
      }
      byCategory[d.category].push(d);
    });

    Object.entries(byCategory).forEach(([cat, items]) => {
      console.log(`\n  defect:${cat} (${items.length})`);
      items.forEach(d => {
        console.log(`    • ${d.flow}: ${d.description}`);
      });
    });
  } else {
    console.log('  ✓ No visual defects detected');
  }

  // Write defect report for bead filing
  const reportPath = path.join(SCREENSHOT_DIR, 'defects.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    defects,
    screenshots
  }, null, 2));
  console.log(`\nDefect report saved to: ${reportPath}`);
}

captureAndAnalyze().catch(console.error);
