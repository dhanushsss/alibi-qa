import { test as base, expect, type Page } from '@playwright/test';
import { richBundle, SYNTHETIC_LOG, type FixVariant } from './bundles.ts';

export const test = base.extend<{ seeded: { replayId: string; heuristicId: string } }>({
  baseURL: async ({}, use) => use(process.env.E2E_BASE_URL),
  seeded: async ({}, use) => {
    const [replayId, heuristicId] = (process.env.E2E_SEEDED ?? '').split(',');
    await use({ replayId, heuristicId });
  },
});
export { expect };

/** Serves a synthetic bundle (and its log) for one investigation id; everything else hits the real server. */
export async function mockInvestigation(page: Page, variant: FixVariant = 'VERIFIED') {
  const bundle = richBundle(variant);
  const id = bundle.investigation.id;
  await page.route(new RegExp(`/api/investigations/${id}(\\?.*)?$`), (r) => r.fulfill({ json: bundle }));
  await page.route(new RegExp(`/api/investigations/${id}/log`), (r) => r.fulfill({ json: SYNTHETIC_LOG }));
  return bundle;
}

/** Page width must not exceed the viewport (no horizontal scroll). */
export async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
