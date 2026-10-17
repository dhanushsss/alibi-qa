/**
 * B/E. Evidence Path, ledger navigation, outcomes, and remediation labels for
 * rich states served by page.route() from synthetic, internally consistent
 * bundles (e2e/support/bundles.ts). The bundles themselves pass the suite's
 * integrity checks (asserted below), so the UI is judged against valid data.
 */
import { checkBundle, DOCUMENTED_CHECKS, failing } from '../scripts/lib/integrity.ts';
import { richBundle } from './support/bundles.ts';
import { expect, mockInvestigation, test } from './support/fixtures.ts';

test('[B0] the synthetic bundles are internally consistent', () => {
  for (const v of ['VERIFIED', 'REJECTED'] as const) expect(failing(checkBundle(richBundle(v) as any), DOCUMENTED_CHECKS)).toEqual([]);
});

test('[B4] contradicted hypotheses and skipped experiments are labelled as such', async ({ page }) => {
  const b = await mockInvestigation(page);
  await page.goto(`/investigations/${b.investigation.id}`);
  const steps = page.getByRole('list', { name: 'Evidence path steps' });
  await expect(steps.getByRole('button', { name: /^Hypotheses: H2\. Contradicted\./ })).toBeVisible();
  await expect(steps.getByRole('button', { name: /^Hypotheses: H2\./ })).not.toHaveAccessibleName(/Supported/);
  await expect(steps.getByRole('button', { name: /^Experiments: Search for external evidence\. Skipped\./ })).toBeVisible();
  await expect(steps.getByRole('button', { name: /^Experiments: Search for external evidence\./ })).not.toHaveAccessibleName(/passed|completed/i);
});

test('[B6] proposed patches are never labelled validated', async ({ page }) => {
  const b = await mockInvestigation(page);
  await page.goto(`/investigations/${b.investigation.id}`);
  const steps = page.getByRole('list', { name: 'Evidence path steps' });
  await expect(steps.getByRole('button', { name: /^Remediation: Quarantine.*Proposed · not validated/ })).toBeVisible();
  await expect(steps.getByRole('button', { name: /^Remediation: Targeted fix.*Validation failed/ })).toBeVisible();
  await expect(steps.getByRole('button', { name: /^Remediation: Revert.*Validated fix/ })).toBeVisible();
  const card = page.locator('#patch-card-patch_qa3');
  await expect(card).toContainText('Proposed — not validated');
  await expect(card).not.toContainText('Validated fix');
});

test('[B3] a ledger link from the Evidence Path opens the exact ledger record', async ({ page }) => {
  const b = await mockInvestigation(page);
  await page.goto(`/investigations/${b.investigation.id}`);
  await page.getByRole('button', { name: /^Failure: Failing test: a fails at the boundary\./ }).click();
  await page.getByRole('link', { name: /Ledger record #1/ }).click();
  await expect(page).toHaveURL(new RegExp(`/ledger#ev_qa01$`));
  const rec = page.locator('li.entry#ev_qa01');
  await expect(rec).toBeVisible();
  await expect(rec).toContainText('Failing test: a fails at the boundary');
  await expect(rec).toHaveClass(/\bhl\b/);
});

test('[B2] relationships shown for a hypothesis are backed by ledger inferences', async ({ page }) => {
  const b = await mockInvestigation(page);
  await page.goto(`/investigations/${b.investigation.id}`);
  await page.getByRole('button', { name: /^Hypotheses: H1\./ }).click();
  const links = page.locator('.ep-rel a[href*="/ledger#"]');
  await expect(links.first()).toBeVisible();
  const hrefs = await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).hash.slice(1)));
  const h1 = b.hypotheses.find((h) => h.key === 'H1')!;
  for (const id of hrefs) {
    const rec = b.evidence.find((e) => e.id === id);
    expect(rec, `link to missing record ${id}`).toBeTruthy();
    if (rec!.kind === 'observed_fact') {
      // "cites": the fact whose log lines contain a verified quote of H1.
      const [from, to] = (rec!.provenance as any).lines;
      expect(h1.supporting.some((q: any) => q.verified && q.logLine >= from && q.logLine <= to)).toBe(true);
    } else {
      expect(rec!.kind).toBe('inference');
      expect(rec!.hypothesisKey).toBe('H1');
      expect(['supports', 'contradicts']).toContain(rec!.effect);
    }
  }
  const inferenceLink = hrefs.find((id) => b.evidence.find((e) => e.id === id)?.kind === 'inference')!;
  await page.locator(`.ep-rel a[href$="#${inferenceLink}"]`).first().click();
  await expect(page.locator(`li.entry#${inferenceLink}`)).toHaveClass(/\bhl\b/);
});

test('[B5][E4] diagnosis and fix outcomes are shown separately — verified fix', async ({ page }) => {
  const b = await mockInvestigation(page, 'VERIFIED');
  await page.goto(`/investigations/${b.investigation.id}`);
  await expect(page.getByLabel('Diagnosis outcome')).toContainText('Cause confirmed');
  await expect(page.getByLabel('Fix outcome')).toContainText('Fix verified');
});

test('[B5][E4] a confirmed-looking cause never lifts rejected fixes', async ({ page }) => {
  const b = await mockInvestigation(page, 'REJECTED');
  await page.goto(`/investigations/${b.investigation.id}`);
  await expect(page.getByLabel('Diagnosis outcome')).toContainText('Cause probable');
  await expect(page.getByLabel('Fix outcome')).toContainText('Fixes rejected');
  await expect(page.locator('main')).not.toContainText('Fix verified');
  await expect(page.locator('main')).not.toContainText('Validated fix');
});

test('[E3] experiment details and remediation validation runs are reachable from the path', async ({ page }) => {
  const b = await mockInvestigation(page);
  await page.goto(`/investigations/${b.investigation.id}`);
  await page.getByRole('button', { name: /^Experiments: Reproduce the failure\./ }).click();
  await page.getByRole('link', { name: 'Open experiment' }).click();
  await expect(page.getByRole('heading', { name: 'Reproduce the failure', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Run #1')).toContainText('a fails at the boundary');
  await page.goto(`/investigations/${b.investigation.id}/experiments`);
  await expect(page.getByRole('heading', { name: 'Fix validation' })).toBeVisible();
});

test('[E5] Evidence Path supports arrow-key navigation and Escape', async ({ page }) => {
  const b = await mockInvestigation(page);
  await page.goto(`/investigations/${b.investigation.id}`);
  const first = page.locator('[data-col="0"][data-row="0"]');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(':focus')).toHaveAttribute('data-col', '1');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(':focus')).toHaveAttribute('data-row', '1');
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
});
