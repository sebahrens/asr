import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

test('Review Queue - Verify submissions render correctly', async ({ page }) => {
  // Set to desktop viewport
  await page.setViewportSize({ width: 1280, height: 800 });

  // Navigate to review
  await page.goto(`${BASE_URL}/review`);
  await page.waitForLoadState('networkidle');

  // Log the page content for debugging
  const content = await page.content();
  console.log('Review page HTML length:', content.length);
  console.log('Has "secure-code-review":', content.includes('secure-code-review'));
  console.log('Has "release-notes":', content.includes('release-notes'));
  console.log('Has "Review queue":', content.includes('Review queue'));

  // Check for header
  const header = page.locator('h1:has-text("Review queue")');
  await expect(header).toBeVisible({ timeout: 5000 }).catch(async (e) => {
    const h1s = await page.locator('h1').count();
    console.log(`Found ${h1s} h1 elements`);
    if (h1s > 0) {
      const h1Text = await page.locator('h1').first().textContent();
      console.log(`First h1 text: "${h1Text}"`);
    }
    throw e;
  });

  // Check for submissions in table
  const rows = page.locator('table tbody tr, article, [role="row"]');
  const rowCount = await rows.count();
  console.log(`Found ${rowCount} submission rows`);

  // Look for skill names specifically
  const skillNames = await page.locator('text=/secure|release/').count();
  console.log(`Found ${skillNames} elements with skill names`);

  // Get all text content to see what's actually there
  const bodyText = await page.textContent('body');
  if (bodyText) {
    const lines = bodyText.split('\n').filter(l => l.trim().length > 0);
    console.log('Page text (first 30 lines):');
    lines.slice(0, 30).forEach((line, i) => {
      console.log(`  ${i}: ${line.trim()}`);
    });
  }

  await page.screenshot({ path: '.playwright-mcp/review-queue-actual.png', fullPage: true });
  console.log('Screenshot saved to .playwright-mcp/review-queue-actual.png');
});
