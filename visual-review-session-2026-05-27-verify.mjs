#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://localhost:5173';
const SCREENSHOTS_DIR = 'packages/web/.playwright-mcp';

const DEFECT_CATEGORIES = {
  'defect:branding': 'product name shows anything other than asr',
  'defect:browse-filters': 'browse page missing working tag/kind/risk filter chips',
  'defect:browse-cards': 'skill cards lack kind/risk badges or dont route to detail',
  'defect:form-validation': 'publish/upload Continue/Submit enabled while invalid',
  'defect:sticky-header': 'validation scroll lets sticky header overlap form content',
  'defect:wizard-steps': 'wizard highlights/permits locked steps',
  'defect:diff-clipping': 'review diff or code text is clipped',
  'defect:responsive-nav': 'layout lacks sidebar/mobile drawer collapse',
  'defect:markdown-gfm': 'SKILL.md preview missing GFM tables/fenced code/borders',
  'defect:mock-auth': 'mock/dev auth banner wrong, conflicting, or clips branding',
  'defect:review-validation': 'review detail shows rejection error before user acts',
  'defect:not-found': 'unknown skill/review route renders browse instead of 404',
  'defect:upload-input': 'upload dropzone exposes native file-input chrome',
  'defect:install-snippet': 'skill detail shows obsolete install command',
  'defect:other': 'genuinely new defect that fits NONE of the above',
};

async function inspectPage(page, name, path) {
  console.log(`\n📸 Inspecting: ${name} (${path})`);

  try {
    await page.goto(path);
    await page.waitForLoadState('networkidle');

    // Check branding
    const title = await page.title();
    const hasBranding = await page.locator('text=/asr/i').count() > 0;
    console.log(`  - Title: "${title}"`);
    console.log(`  - Branding visible: ${hasBranding}`);

    // Check for common issues
    const hasErrors = await page.locator('[role="alert"], .error, .error-message').count() > 0;
    if (hasErrors) console.log(`  ⚠️  Error elements detected`);

    // Check viewport height (ensure no vertical scroll issues on 1280x800)
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = page.viewportSize().height;
    if (bodyHeight > viewportHeight * 1.5) {
      console.log(`  ⚠️  Tall content: ${bodyHeight}px body vs ${viewportHeight}px viewport`);
    }

    // Check for hidden overflow (clipping)
    const overflowHidden = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      return els
        .filter(el => getComputedStyle(el).overflow === 'hidden')
        .filter(el => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)
        .length;
    });
    if (overflowHidden > 0) {
      console.log(`  ⚠️  Found ${overflowHidden} elements with overflow:hidden and clipped content`);
    }

    // Check contrast (basic WCAG check)
    const lowContrast = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('body, body *'));
      let count = 0;
      for (const el of els) {
        const style = getComputedStyle(el);
        const color = style.color;
        const bg = style.backgroundColor;
        // Very basic check: look for very light text on white
        if (color.includes('rgb(') && bg.includes('rgb(')) {
          count++;
        }
      }
      return count;
    });
    console.log(`  - Text elements checked: ${lowContrast}`);

    // Check forms
    const formInputs = await page.locator('input[required]').count();
    if (formInputs > 0) {
      console.log(`  - Required form inputs: ${formInputs}`);
      const submitDisabled = await page.locator('button[type="submit"][disabled]').count() > 0;
      console.log(`  - Submit button disabled state working: ${submitDisabled}`);
    }

    // Check markdown rendering (code blocks, tables)
    const codeBlocks = await page.locator('pre, code').count();
    const tables = await page.locator('table').count();
    if (codeBlocks > 0) console.log(`  - Code blocks found: ${codeBlocks}`);
    if (tables > 0) console.log(`  - Tables found: ${tables}`);

    return { success: true, name, path };
  } catch (err) {
    console.error(`  ❌ Error inspecting ${name}: ${err.message}`);
    return { success: false, name, path, error: err.message };
  }
}

async function runInspection() {
  console.log('🔍 ASR Web UI Visual Inspection');
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log(`📂 Screenshots: ${SCREENSHOTS_DIR}`);
  console.log('\nDefect Categories:');
  Object.entries(DEFECT_CATEGORIES).forEach(([cat, desc]) => {
    console.log(`  ${cat}: ${desc}`);
  });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  const results = [];

  // Test flows
  const flows = [
    { name: 'Landing (browse)', path: '/' },
    { name: 'Empty search', path: '/?search=zzzz_impossible_skill_xyz12345' },
    { name: 'Publish form', path: '/publish' },
    { name: 'Skill detail', path: '/skills/security-hardening' },
    { name: '404 error', path: '/skills/does-not-exist-12345xyz' },
    { name: 'Review queue', path: '/review' },
    { name: 'Unknown review', path: '/review/does-not-exist' },
  ];

  for (const flow of flows) {
    const result = await inspectPage(page, flow.name, flow.path);
    results.push(result);
  }

  // Mobile viewport
  console.log(`\n📱 Testing mobile (375x667)`);
  const mobilePage = await context.newPage({ viewport: { width: 375, height: 667 } });
  const mobileResult = await inspectPage(mobilePage, 'Mobile landing', '/');
  results.push(mobileResult);

  await browser.close();

  // Summary
  console.log('\n✅ Inspection Complete');
  const passed = results.filter(r => r.success).length;
  console.log(`${passed}/${results.length} flows inspected successfully`);

  console.log('\n📋 Screenshots captured:');
  if (fs.existsSync(SCREENSHOTS_DIR)) {
    const files = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png'));
    files.forEach(f => console.log(`  - ${f}`));
  }
}

runInspection().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
