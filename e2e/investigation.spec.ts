/**
 * E/B. Full investigation details for REAL seeded investigations (Replay mode,
 * sandbox disabled): what the UI shows must match the API records.
 */
import { expect, test } from './support/fixtures.ts';

test('[E2] detail page labels the mode honestly and never shows a skipped experiment as passed', async ({ page, seeded, request }) => {
  const b = await (await request.get(`/api/investigations/${seeded.replayId}`)).json();
  await page.goto(`/investigations/${seeded.replayId}`);
  const head = page.locator('.inv-head');
  await expect(head).toContainText('Replay');
  await expect(head).not.toContainText('Live Nemotron');
  const steps = page.getByRole('list', { name: 'Evidence path steps' });
  await expect(steps).toBeVisible();
  for (const e of b.experiments.filter((x: any) => x.status === 'skipped')) {
    const node = steps.getByRole('button', { name: new RegExp(`^Experiments: ${e.title}\\.`) });
    await expect(node).toHaveAccessibleName(/Skipped/);
    await expect(node).not.toHaveAccessibleName(/Tests passed/);
  }
});

test('[B8] Evidence Path and ledger counts match the API records', async ({ page, seeded, request }) => {
  const b = await (await request.get(`/api/investigations/${seeded.replayId}`)).json();
  await page.goto(`/investigations/${seeded.replayId}`);
  const steps = page.getByRole('list', { name: 'Evidence path steps' });
  await expect(steps.getByRole('button', { name: /^Hypotheses: / })).toHaveCount(b.hypotheses.length);
  const diag = b.experiments.filter((e: any) => e.kind !== 'validate_patch' && e.kind !== 'regression_suite');
  await expect(steps.getByRole('button', { name: /^Experiments: / })).toHaveCount(diag.length);
  await expect(steps.getByRole('button', { name: /^Remediation: / })).toHaveCount(b.patches.length);
  const verdict = b.investigation.verdict as string;
  await expect(steps.getByRole('button', { name: /^Diagnosis: / })).toHaveAccessibleName(new RegExp(verdict, 'i'));
  for (const h of b.hypotheses) {
    const state = h.status === 'supported' ? 'Supported' : h.status === 'refuted' ? 'Contradicted' : h.status === 'inconclusive' ? 'Unresolved' : 'Not yet tested';
    await expect(steps.getByRole('button', { name: new RegExp(`^Hypotheses: ${h.key}\\. ${state}\\.`) })).toBeVisible();
  }
  await page.getByRole('link', { name: /Evidence ledger/ }).click();
  await expect(page.locator('li.entry')).toHaveCount(b.evidence.length);
});

test('[E3] experiment detail of a skipped experiment says it was not executed', async ({ page, seeded, request }) => {
  const b = await (await request.get(`/api/investigations/${seeded.replayId}`)).json();
  const skipped = b.experiments.find((e: any) => e.status === 'skipped');
  await page.goto(`/investigations/${seeded.replayId}/experiments`);
  await page.getByRole('link', { name: skipped.title }).first().click();
  await expect(page.getByRole('heading', { name: skipped.title, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Not executed' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Experiment summary' })).not.toContainText(/passed/i);
});

test('[E2] CI log tab shows the stored, redacted log and highlights a linked line', async ({ page, seeded }) => {
  await page.goto(`/investigations/${seeded.replayId}/log?line=3`);
  await expect(page.getByLabel('CI log')).toBeVisible();
  await expect(page.getByText('Secrets were redacted before storage')).toBeVisible();
  await expect(page.locator('.logview .l.hl')).toHaveCount(1);
  await expect(page.locator('.logview .l.hl')).toHaveAttribute('data-line', '3');
});

test('[E2] model calls tab shows replayed calls, not live ones', async ({ page, seeded }) => {
  await page.goto(`/investigations/${seeded.replayId}/models`);
  await expect(page.locator('table.table')).toContainText('replay');
  await expect(page.locator('table.table')).not.toContainText(/\bok\b/);
});
