/**
 * E. Automated accessibility audit (axe-core, WCAG 2.0/2.1 A and AA rules) of the
 * main pages: real seeded data plus one route-mocked rich investigation. Fails on
 * serious or critical violations and lists every violation with its targets.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, mockInvestigation, test } from './support/fixtures.ts';

async function audit(page: import('@playwright/test').Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  return bad.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

const PAGES: Array<[string, string]> = [
  ['/overview', 'Overview'],
  // Public pages: the landing page at / and the documentation.
  ['/', "Don't just explain the failure. Prove it."],
  ['/docs', 'Zerqis product guide'],
  ['/investigations', 'Investigations'],
  ['/integrations', 'Integrations'],
  ['/settings', 'Settings'],
];

for (const [path, heading] of PAGES) {
  test(`[E8] ${heading} has no serious or critical WCAG A/AA violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await audit(page)).toEqual([]);
  });
}

test('[E8] a real investigation detail page has no serious or critical WCAG A/AA violations', async ({ page, seeded }) => {
  await page.goto(`/investigations/${seeded.replayId}`);
  await expect(page.getByRole('list', { name: 'Evidence path steps' })).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

test('[E8] a detail page with validated and failed fixes has no serious or critical WCAG A/AA violations', async ({ page }) => {
  const b = await mockInvestigation(page);
  await page.goto(`/investigations/${b.investigation.id}`);
  await expect(page.getByLabel('Fix outcome')).toBeVisible();
  expect(await audit(page)).toEqual([]);
});
