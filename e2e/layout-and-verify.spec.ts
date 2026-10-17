/**
 * L. Full-width layout at desktop, tablet, and mobile widths, and V. the change
 * verification page in a real browser. The e2e server has its sandbox disabled, so
 * a verification started here must end "blocked", and say why.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, horizontalOverflow, test } from './support/fixtures.ts';

const WIDTHS = [1440, 1280, 1024, 768, 390] as const;
const DESKTOP_MIN = 901; // the sidebar becomes a drawer at 900px and below

async function shell(page: Page) {
  return page.evaluate(() => {
    const box = (s: string) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    };
    const content = document.querySelector('.content')!;
    const cs = getComputedStyle(content);
    return {
      viewport: document.documentElement.clientWidth,
      sidebar: box('.sidebar'),
      main: box('.main'),
      content: box('.content'),
      padLeft: parseFloat(cs.paddingLeft),
      padRight: parseFloat(cs.paddingRight),
      maxWidth: cs.maxWidth,
    };
  });
}

async function openPage(page: Page, name: string, path: string | null) {
  if (path) await page.goto(path);
  else {
    // Navigate via the main nav so the test does not assume which route hosts a page.
    await page.goto('/investigations');
    const menu = page.getByRole('button', { name: 'Open navigation' });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
  }
  await page.waitForLoadState('networkidle');
}

for (const width of WIDTHS) {
  test(`[L1] ${width}px: the shell uses the available width and no page overflows horizontally`, async ({ page, seeded }) => {
    await page.setViewportSize({ width, height: 900 });
    const pages: Array<[string, string | null]> = [
      ['Overview', null],
      ['Investigations', '/investigations'],
      ['Investigation detail', `/investigations/${seeded.replayId}`],
      ['Verify a change', '/verify'],
      ['Integrations', '/integrations'],
      ['Settings', '/settings'],
    ];
    for (const [name, path] of pages) {
      await openPage(page, name, path);
      const m = await shell(page);
      const where = `${name} at ${width}px: ${JSON.stringify(m)}`;
      expect(m.maxWidth, where).toBe('none');
      // Main content reaches the right edge of the viewport: no unexplained blank band.
      expect(Math.abs(m.main!.right - m.viewport), where).toBeLessThanOrEqual(1);
      expect(Math.abs(m.content!.right - m.viewport), where).toBeLessThanOrEqual(1);
      // Padding is intentional and bounded, not a percentage gutter.
      expect(m.padLeft, where).toBeGreaterThanOrEqual(16);
      expect(m.padLeft, where).toBeLessThanOrEqual(48);
      expect(m.padRight, where).toBe(m.padLeft);
      if (width >= DESKTOP_MIN) {
        // Sidebar beside the content; main takes all of the rest.
        expect(m.sidebar!.left, where).toBe(0);
        expect(Math.abs(m.main!.left - m.sidebar!.right), where).toBeLessThanOrEqual(1);
        expect(Math.abs(m.main!.width - (m.viewport - m.sidebar!.width)), where).toBeLessThanOrEqual(1);
      } else {
        // Drawer navigation: content spans the viewport.
        expect(m.main!.left, where).toBe(0);
        expect(m.sidebar!.right, where).toBeLessThanOrEqual(0);
      }
      expect(await horizontalOverflow(page), where).toBeLessThanOrEqual(1);
    }
  });
}

test('[L2] on a phone, wide content scrolls inside its own container, never the page', async ({ page, seeded }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/investigations/${seeded.replayId}`);
  await expect(page.getByRole('list', { name: 'Evidence path steps' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.goto(`/investigations/${seeded.replayId}/log`);
  await page.waitForLoadState('networkidle');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.goto('/investigations');
  await page.waitForLoadState('networkidle');
  const wraps = await page.evaluate(() => [...document.querySelectorAll('.table-wrap')].map((w) => getComputedStyle(w).overflowX));
  for (const o of wraps) expect(o).toBe('auto');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test('[L3] explanatory text keeps a readable line length on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/verify');
  const lead = await page.locator('.page-head .lead').evaluate((e) => ({ w: e.getBoundingClientRect().width, font: parseFloat(getComputedStyle(e).fontSize) }));
  expect(lead.w / lead.font).toBeLessThanOrEqual(46); // 72ch at ~0.6em per character
});

test('[L4] keyboard: skip link and visible focus still work in the full-width shell', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/verify');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  // Tab into the form: the first radio is reachable and shows a focus indicator.
  const radio = page.getByRole('radio', { name: 'Sample repository' });
  await page.keyboard.press('Tab');
  await expect(radio).toBeFocused();
  const outline = await radio.evaluate((e) => getComputedStyle(e).outlineStyle + ' ' + getComputedStyle(e).outlineWidth);
  expect(outline).not.toMatch(/^none|0px$/);
});

test('[V-UI] Verify a change is discoverable, refuses malformed input, and reports a blocked run honestly', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/investigations');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Verify a change' }).click();
  await expect(page.getByRole('heading', { name: 'Verify a change', level: 1 })).toBeVisible();
  await expect(page.getByText(/Authorship is not detected or inferred/)).toBeVisible();

  // Public GitHub: branch names are not accepted, so the button stays disabled.
  await page.getByRole('radio', { name: 'Public GitHub repository' }).check();
  await page.getByLabel('Repository URL').fill('https://github.com/acme/widgets');
  await page.getByLabel('Base revision (commit SHA)').fill('main');
  await page.getByLabel('Changed revision (commit SHA)').fill('abc1234');
  await expect(page.getByRole('button', { name: 'Verify change' })).toBeDisabled();

  // Sample repository: the two revisions are pre-selected; the sandbox is disabled on this server.
  await page.getByRole('radio', { name: 'Sample repository' }).check();
  await page.getByLabel('Repository to verify').selectOption({ label: 'alibi-demo/pricing-engine (jest)' });
  await expect(page.getByLabel('Changed revision')).toHaveValue(/^[0-9a-f]{40}$/);
  await page.getByRole('button', { name: 'Verify change' }).click();
  await expect(page).toHaveURL(/\/investigations\/inv_/);
  const panel = page.getByRole('region', { name: 'Change verification' });
  await expect(panel.getByText('Blocked')).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/Sandbox runner unavailable/)).toBeVisible();
  await expect(panel.getByText('No fix proposed')).toBeVisible();
  await expect(panel.getByText(/not who or what wrote it/)).toBeVisible();
  await expect(page.getByText(/AI[- ]generated/i)).toHaveCount(0);
  await expect(page.locator('#verdict-card')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Test output' }).first()).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  const audit = async () => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  };
  expect(await audit()).toEqual([]);
  await page.goto('/verify');
  await expect(page.getByRole('table')).toContainText('Blocked');
  await page.waitForLoadState('networkidle');
  expect(await audit()).toEqual([]);
});

test('[V-UI] reduced motion: the verification page renders without running animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/verify');
  await page.waitForLoadState('networkidle');
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect?.getTiming().duration as number) > 50).length);
  expect(running).toBe(0);
});
