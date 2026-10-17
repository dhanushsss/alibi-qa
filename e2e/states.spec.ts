/** E. Loading, error, empty, and partial-data states, driven with page.route(). */
import { richBundle } from './support/bundles.ts';
import { expect, test } from './support/fixtures.ts';

test('[E6] loading state is announced until data arrives', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/overview', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/overview');
  await expect(page.locator('[role="status"][aria-busy="true"]').first()).toBeVisible();
  release();
  await expect(page.getByRole('region', { name: 'Metrics' })).toBeVisible();
  await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(0);
});

test('[E6] API errors are shown with a working retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/investigations', (route) =>
    fail ? route.fulfill({ status: 500, json: { error: 'QA injected failure' } }) : route.fulfill({ json: [] }),
  );
  await page.goto('/investigations');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Something went wrong. QA injected failure');
  fail = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'No investigations yet' })).toBeVisible();
});

test('[E6] empty overview explains there is nothing yet', async ({ page }) => {
  await page.route('**/api/overview', (route) =>
    route.fulfill({ json: { totals: { investigations: 0, experiments: 0, executedRuns: 0, validatedFixes: 0, patchesTotal: 0 }, byClassification: {}, byVerdict: {}, byStatus: {}, bySource: {}, recent: [], repositories: [] } }),
  );
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'No investigations yet' })).toBeVisible();
});

test('[E6] a running investigation with partial data renders without claiming a verdict', async ({ page }) => {
  const full = richBundle('VERIFIED', 'inv_qapartial');
  const partial = {
    ...full,
    investigation: { ...full.investigation, status: 'running', stage: 'Forming hypotheses', verdict: null, classification: null, confidence: null, primaryHypothesis: null, agent: undefined, verdictHistory: [] },
    hypotheses: [],
    experiments: [],
    evidence: full.evidence.slice(0, 1),
    patches: [],
  };
  await page.route(/\/api\/investigations\/inv_qapartial(\?.*)?$/, (r) => r.fulfill({ json: partial }));
  await page.goto('/investigations/inv_qapartial');
  await expect(page.getByRole('heading', { name: 'alibi-qa/ui-fixture', level: 1 })).toBeVisible();
  await expect(page.getByText('Forming hypotheses…')).toBeVisible();
  const steps = page.getByRole('list', { name: 'Evidence path steps' });
  await expect(steps.getByRole('button', { name: /^Diagnosis: No verdict yet\./ })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/Confirmed|Fix verified|Validated fix/);
});

test('[E6] an unknown investigation shows a not-found error, not a blank page', async ({ page }) => {
  await page.goto('/investigations/inv_doesnotexist');
  await expect(page.getByRole('alert')).toContainText('Investigation not found');
});
