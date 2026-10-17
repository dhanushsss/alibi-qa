/** E. Navigation on desktop, tablet, and mobile viewports (real server, seeded data). */
import { expect, horizontalOverflow, test } from './support/fixtures.ts';

const PAGES: Array<[string, string]> = [
  ['Investigations', 'Investigations'],
  ['Integrations', 'Integrations'],
  ['Settings', 'Settings'],
  ['Overview', 'Overview'],
];

test('[E1] main navigation reaches every page without horizontal scrolling', async ({ page }) => {
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation' });
  for (const [link, heading] of PAGES) {
    const drawer = await menu.isVisible();
    if (drawer) {
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
    }
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    if (drawer) await expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(await horizontalOverflow(page), `${link} overflows horizontally`).toBeLessThanOrEqual(1);
  }
});

test('[E1] overview and history list the seeded investigations', async ({ page, seeded }) => {
  await page.goto('/investigations');
  await expect(page.locator('a.repo', { hasText: 'alibi-demo/pricing-engine' }).first()).toBeVisible();
  await expect(page.locator('a.repo', { hasText: 'alibi-demo/checkout-service' }).first()).toBeVisible();
  await page.getByLabel('Search investigations').fill('checkout');
  await expect(page.locator('a.repo', { hasText: 'alibi-demo/pricing-engine' })).toHaveCount(0);
  await expect(page.locator('a.repo', { hasText: 'alibi-demo/checkout-service' }).first()).toBeVisible();
  await page.goto(`/investigations/${seeded.replayId}`);
  await expect(page.getByRole('heading', { name: 'alibi-demo/pricing-engine', level: 1 })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});
